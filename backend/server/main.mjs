import {
  readFileSync,
  mkdirSync,
  rmSync,
  lstatSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { Store } from "./store.mjs";
import { Service } from "./service.mjs";
import { Codex } from "./codex.mjs";
import { createApi } from "./http.mjs";

export async function start(config, token) {
  if (
    !config ||
    Object.keys(config).some(
      (key) =>
        ![
          "data_directory",
          "runtime_registration",
          "codex_home",
          "port",
        ].includes(key),
    )
  )
    throw new Error("Invalid service configuration");
  for (const key of ["data_directory", "runtime_registration", "codex_home"]) {
    if (typeof config[key] !== "string" || !path.isAbsolute(config[key])) {
      throw new Error(`Expected absolute ${key}`);
    }
  }
  if (
    !Number.isInteger(config.port) ||
    config.port < 0 ||
    config.port > 65535
  ) {
    throw new Error("Invalid port");
  }
  if (typeof token !== "string" || token.length < 32)
    throw new Error("Set MATHMODEL_AGENT_TOKEN");
  const registration = JSON.parse(
    readFileSync(config.runtime_registration, "utf8"),
  );
  if (
    registration.kind !== "source-build" ||
    !/^[a-f0-9]{40}$/.test(registration.source_commit) ||
    !path.isAbsolute(registration.binary) ||
    !/^[a-f0-9]{64}$/.test(registration.sha256)
  ) {
    throw new Error("A source-build runtime registration is required");
  }
  const repository = realpathSync(
    fileURLToPath(new URL("..", import.meta.url)),
  );
  for (const directory of [config.data_directory, config.codex_home]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    const resolved = realpathSync(directory);
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid()) ||
      resolved === repository ||
      resolved.startsWith(repository + path.sep)
    ) {
      throw new Error(
        "Runtime directories must be private, owned and outside the repository",
      );
    }
  }
  const lock = path.join(config.data_directory, ".daemon-lock");
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch {
    throw new Error(
      "Data directory is locked; inspect the prior process before recovery",
    );
  }
  writeFileSync(
    path.join(lock, "owner.json"),
    JSON.stringify({ pid: process.pid }),
    { mode: 0o600 },
  );
  let store, service, api;
  try {
    const runtimeFactory = () =>
      new Codex({
        binary: registration.binary,
        sha256: registration.sha256,
        home: config.codex_home,
      });
    runtimeFactory(); // Verify the registered executable before accepting work.
    const workspaceRoot = path.join(config.data_directory, "workspaces");
    mkdirSync(workspaceRoot, { mode: 0o700, recursive: true });
    store = new Store(path.join(config.data_directory, "state.sqlite"));
    service = new Service({ store, workspaceRoot, runtimeFactory });
    api = createApi({ service, token });
    await new Promise((resolve, reject) => {
      api.once("error", reject);
      api.listen(config.port, "127.0.0.1", resolve);
    });
    service.recover();
    let closing;
    return {
      port: api.address().port,
      service,
      close() {
        closing ??= (async () => {
          api.closeIdleConnections();
          await new Promise((resolve) => api.close(resolve));
          await service.close();
          store.close();
          rmSync(lock, { recursive: true });
        })();
        return closing;
      },
    };
  } catch (error) {
    api?.close();
    if (service) await service.close();
    store?.close();
    rmSync(lock, { recursive: true });
    throw error;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  if (process.argv.length !== 4 || process.argv[2] !== "--config") {
    process.stderr.write(
      "Usage: npm start -- --config /absolute/service.json\n",
    );
    process.exitCode = 1;
  } else {
    try {
      const app = await start(
        JSON.parse(readFileSync(process.argv[3], "utf8")),
        process.env.MATHMODEL_AGENT_TOKEN,
      );
      process.stdout.write(
        `Mathmodel Agent listening at http://127.0.0.1:${app.port}\n`,
      );
      const stop = () =>
        app.close().catch(() => {
          process.exitCode = 1;
        });
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    }
  }
}
