import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { DomainError } from "./contracts.mjs";

export function createApi({ service, token }) {
  if (typeof token !== "string" || token.length < 32)
    throw new Error("A private API token is required");
  const expected = Buffer.from(`Bearer ${token}`);
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    const reply = (code, value) => {
      response.writeHead(code);
      response.end(JSON.stringify(value));
    };
    try {
      const supplied = Buffer.from(request.headers.authorization ?? "");
      const hosts = new Set([`127.0.0.1:${server.address().port}`]);
      const count = (name) =>
        request.rawHeaders.filter(
          (_, index) =>
            index % 2 === 0 && request.rawHeaders[index].toLowerCase() === name,
        ).length;
      if (
        request.headers.origin !== undefined ||
        !hosts.has(request.headers.host) ||
        count("host") !== 1 ||
        count("authorization") !== 1 ||
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      ) {
        reply(403, {
          code: "forbidden",
          message: "Local authenticated requests only",
        });
        request.resume();
        return;
      }
      const url = new URL(request.url, "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/health") {
        return reply(200, { status: "ok", contract_version: "v2" });
      }
      if (request.method === "POST" && url.pathname === "/v2/commands") {
        if (
          request.headers["content-type"]?.split(";")[0] !== "application/json"
        ) {
          throw new DomainError("invalid_request", "Expected application/json");
        }
        const chunks = [];
        let size = 0;
        for await (const chunk of request.iterator({
          destroyOnReturn: false,
        })) {
          size += chunk.length;
          if (size > 65536) {
            response.setHeader("connection", "close");
            request.resume();
            throw new DomainError("invalid_request", "Request body too large");
          }
          chunks.push(chunk);
        }
        let command;
        try {
          command = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          throw new DomainError("invalid_request", "Invalid JSON");
        }
        return reply(200, service.command(command));
      }
      if (request.method === "GET" && url.pathname === "/v2/projects") {
        return reply(200, { projects: service.store.projects() });
      }
      if (request.method === "GET" && url.pathname === "/v2/runs") {
        return reply(200, { runs: service.store.runs() });
      }
      const match = /^\/v2\/runs\/([A-Za-z0-9._:-]+)(\/events)?$/.exec(
        url.pathname,
      );
      if (request.method === "GET" && match) {
        if (match[2])
          return reply(
            200,
            service.store.events(
              match[1],
              Number(url.searchParams.get("after") ?? 0),
              Number(url.searchParams.get("limit") ?? 200),
            ),
          );
        return reply(200, service.store.run(match[1]));
      }
      reply(404, { code: "not_found", message: "Route not found" });
    } catch (error) {
      const status =
        {
          invalid_request: 400,
          not_found: 404,
          conflict: 409,
          runtime_unavailable: 503,
        }[error.code] ?? 500;
      if (!response.headersSent && !response.destroyed)
        reply(status, {
          code: status === 500 ? "internal_error" : error.code,
          message: status === 500 ? "Internal service error" : error.message,
        });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.maxRequestsPerSocket = 100;
  return server;
}
