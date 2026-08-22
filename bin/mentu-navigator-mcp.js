#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import {
  changeImpact,
  compactResult,
  handleRepository,
  locateRepository,
  mapRepository,
  navigateRepository,
  queryRepository,
  readRangeRepository,
  symbolContext
} from "../src/index.js";

const server = new Server(
  { name: "mentu-navigator", version: "0.3.0" },
  { capabilities: { tools: {} } }
);

const repositoryProperty = {
  repo: {
    type: "string",
    description: "Absolute or current-working-directory-relative repository path."
  }
};

const tools = [
  {
    name: "navigator",
    description: "Preferred entrypoint for agents. Auto-routes one repository question to a map, ranked query, frontmatter handles, symbol context, or Git change-impact report and returns compact source-backed evidence.",
    inputSchema: {
      type: "object",
      required: ["repo"],
      properties: {
        ...repositoryProperty,
        question: { type: "string", description: "Natural-language repository question. Omit for an initial map." },
        mode: { type: "string", enum: ["auto", "map", "query", "handles", "symbol", "impact"], default: "auto" },
        symbol: { type: "string", description: "Known identifier; routes directly to symbol context." },
        base: { type: "string", default: "HEAD~1" },
        head: { type: "string", default: "HEAD" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
        detail: { type: "string", enum: ["compact", "full"], default: "compact" }
      },
      additionalProperties: false
    }
  },
  {
    name: "locate",
    description: "Progressive disclosure entrypoint: fuse a ranked lexical leg and an exact leg into k=8 source ranges, each with path, line, heading-anchored range, a snippet of at most 240 characters, retriever attribution, and its reason. Read a range with read_range before making a claim.",
    inputSchema: {
      type: "object",
      required: ["repo", "query"],
      properties: {
        ...repositoryProperty,
        query: { type: "string", minLength: 1 },
        k: { type: "integer", minimum: 1, maximum: 40, default: 8 },
        scope: {
          type: "array",
          items: { type: "string" },
          description: "Repository-relative path prefixes to restrict results to."
        },
        lang: { type: "string", enum: ["en", "es"], description: "Restrict ranking to documents analyzed in this language." },
        retriever: {
          type: "string",
          enum: ["bm25", "exact", "fused"],
          default: "bm25",
          description: "Measurement only (S8): selects an arm instead of the bm25 default. The fused default was retired by pre-registered study c36."
        },
        demotions: { type: "string", description: "Path to a `pdv demotions` JSON file, resolved against the repository root. Demoted documents rank lower and are never removed." }
      },
      additionalProperties: false
    }
  },
  {
    name: "read_range",
    description: "Return the source lines a locate hit points at. Widening is ±20 lines per step and stops at heading boundaries; frontmatter comes back in its own field and is never inlined into the body slice.",
    inputSchema: {
      type: "object",
      required: ["repo", "path"],
      properties: {
        ...repositoryProperty,
        path: { type: "string", minLength: 1, description: "Repository-relative path from a locate hit." },
        start: { type: "integer", minimum: 1 },
        end: { type: "integer", minimum: 1 },
        widen: { type: "integer", minimum: 0, maximum: 50, default: 0, description: "Widening steps of ±20 lines, clamped to the enclosing heading section." }
      },
      additionalProperties: false
    }
  },
  {
    name: "navigator_handles",
    description: "Specialist tool: discover typed docs and relationships from bounded YAML frontmatter. Results are routing pointers and require reading the source body before claims.",
    inputSchema: {
      type: "object",
      required: ["repo"],
      properties: {
        ...repositoryProperty,
        query: { type: "string", description: "Optional identity, tag, scope, summary, or relationship filter." },
        limit: { type: "integer", minimum: 1, maximum: 200 },
        maxFiles: { type: "integer", minimum: 1, maximum: 100000 }
      },
      additionalProperties: false
    }
  },
  {
    name: "navigator_map",
    description: "Specialist tool: map repository structure, languages, contracts, manifests, and typed docs without reading secrets.",
    inputSchema: {
      type: "object",
      required: ["repo"],
      properties: {
        ...repositoryProperty,
        maxFiles: { type: "integer", minimum: 1, maximum: 100000 }
      },
      additionalProperties: false
    }
  },
  {
    name: "navigator_query",
    description: "Specialist tool: find and rank source-backed repository evidence for a natural-language or exact query.",
    inputSchema: {
      type: "object",
      required: ["repo", "query"],
      properties: {
        ...repositoryProperty,
        query: { type: "string", minLength: 1 },
        limit: { type: "integer", minimum: 1, maximum: 200 }
      },
      additionalProperties: false
    }
  },
  {
    name: "navigator_symbol_context",
    description: "Specialist tool: collect definitions, references, tests, docs, and config surrounding a known symbol.",
    inputSchema: {
      type: "object",
      required: ["repo", "symbol"],
      properties: {
        ...repositoryProperty,
        symbol: { type: "string", minLength: 1 },
        limit: { type: "integer", minimum: 1, maximum: 200 }
      },
      additionalProperties: false
    }
  },
  {
    name: "navigator_change_impact",
    description: "Specialist tool: relate an explicit Git change range to tests, contracts, ticket references, and risk signals.",
    inputSchema: {
      type: "object",
      required: ["repo"],
      properties: {
        ...repositoryProperty,
        base: { type: "string", default: "HEAD~1" },
        head: { type: "string", default: "HEAD" },
        limit: { type: "integer", minimum: 1, maximum: 200 }
      },
      additionalProperties: false
    }
  }
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = request.params.arguments || {};
  try {
    let result;
    if (request.params.name === "navigator") {
      result = navigateRepository({ ...args, limit: args.limit ?? (args.detail === "full" ? undefined : 10) });
      if (args.detail !== "full") result = compactResult(result);
    } else if (request.params.name === "locate") result = locateRepository(args);
    else if (request.params.name === "read_range") result = readRangeRepository(args);
    else if (request.params.name === "navigator_map") result = mapRepository(args);
    else if (request.params.name === "navigator_query") result = queryRepository(args);
    else if (request.params.name === "navigator_handles") result = handleRepository(args);
    else if (request.params.name === "navigator_symbol_context") result = symbolContext(args);
    else if (request.params.name === "navigator_change_impact") result = changeImpact(args);
    else throw new Error(`Unknown tool: ${request.params.name}`);
    const compact = request.params.name === "navigator" && args.detail !== "full";
    return { content: [{ type: "text", text: JSON.stringify(result, null, compact ? 0 : 2) }] };
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ error: error.message }) }]
    };
  }
});

await server.connect(new StdioServerTransport());
