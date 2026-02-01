import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { globSync } from 'glob';

type OpenApiSchema =
    | {
    type?: string | string[];
    format?: string;
    required?: string[];
    properties?: Record<string, OpenApiSchema>;
    items?: OpenApiSchema;
    enum?: string[];
    example?: any;
    $ref?: string;
    allOf?: OpenApiSchema[];
}
    | Record<string, any>;

type Dmmf = {
    datamodel: {
        models: any[];
        enums: any[];
    };
};

type Config = {
    projectRoot: string;
    controllersGlob: string;
    outFile: string;
    openapiOut: string;
    serviceTitle: string;
    serverUrl: string;
    securitySchemeName: string;
    oauth: {
        tokenUrl: string;
        refreshUrl: string;
        scopes: Record<string, string>;
    };
    omitFieldsInWriteDtos: Set<string>;
};

const DEFAULT_CONFIG: Config = {
    projectRoot: process.cwd(),
    controllersGlob: './**/controllers/**/*.ts',
    outFile: './swagger.config.js',
    openapiOut: './**/openapi.json',
    serviceTitle: 'Microservice Swagger Docs',
    serverUrl: 'http://localhost:3000',
    securitySchemeName: 'keycloakOAuth',
    oauth: {
        tokenUrl: 'http://localhost:8080/realms/master/protocol/openid-connect/token',
        refreshUrl: 'http://localhost:8080/realms/master/protocol/openid-connect/refresh',
        scopes: { openid: 'openid' },
    },
    omitFieldsInWriteDtos: new Set(['id', 'createdAt', 'updatedAt', 'v']),
};

type ParsedArgs = {
    schemaPath?: string;
    projectRoot?: string;
    controllersGlob?: string;
    outFile?: string;
    openapiOut?: string;
    serviceTitle?: string;
    serverUrl?: string;
    securitySchemeName?: string;
    oauthTokenUrl?: string;
    oauthRefreshUrl?: string;
    oauthScopes?: Record<string, string>;
    omitFieldsInWriteDtos?: string[];
};

function ensurePosix(p: string) {
    return p.split(path.sep).join(path.posix.sep);
}

function pluralize(name: string) {
    if (name.endsWith('s')) return `${name}es`;
    return `${name}s`;
}

function getRequire() {
    return createRequire(typeof __filename !== 'undefined' ? __filename : process.cwd() + '/');
}

function parseJsonObject(value: string, flagName: string): Record<string, any> {
    try {
        const parsed = JSON.parse(value);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('must be a JSON object');
        }
        return parsed;
    } catch (e: any) {
        throw new Error(`Invalid JSON for ${flagName}: ${e?.message ?? String(e)}`);
    }
}

function parseCsv(value: string): string[] {
    return value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

function readFlagValue(args: string[], flag: string): string | undefined {
    const i = args.findIndex((a) => a === flag);
    if (i < 0) return undefined;
    const v = args[i + 1];
    if (!v || v.startsWith('--')) return undefined;
    return v;
}

function hasFlag(args: string[], flag: string): boolean {
    return args.includes(flag);
}

function parseArgs(args: string[]): ParsedArgs {
    if (hasFlag(args, '--help') || hasFlag(args, '-h')) {
        const help = `
prisma-swagger-autogen

Usage:
  prisma-swagger-autogen [options]

Options:
  --schema <path>                 Prisma schema path (default: ./prisma/schema.prisma)

  --projectRoot <path>            Project root for resolving outFile/openapiOut (default: cwd)
  --controllersGlob <glob>        Glob for controller files (default: ./**/controllers/**/*.ts)
  --outFile <path>                Path to write swagger.config.js (default: ./swagger.config.js)
  --openapiOut <path>             Path swagger-autogen writes OpenAPI JSON (default: ./openapi.json)

  --serviceTitle <string>         OpenAPI title
  --serverUrl <url>               OpenAPI server url
  --securitySchemeName <string>   Security scheme name

  --oauthTokenUrl <url>           OAuth2 tokenUrl
  --oauthRefreshUrl <url>         OAuth2 refreshUrl
  --oauthScopes <json>            OAuth2 scopes as JSON object, e.g. {"openid":"openid scope"}

  --omitFields <csv>              Comma-separated fields to omit in write DTOs (default: id,createdAt,updatedAt,v)

Examples:
  prisma-swagger-autogen
  prisma-swagger-autogen --schema ./prisma/schema.prisma
  prisma-swagger-autogen --controllersGlob "./src/api/**/*.ts" --outFile ./swagger.config.js
  prisma-swagger-autogen --oauthScopes '{"openid":"openid scope","profile":"profile"}'
`.trim();
        process.stdout.write(help + '\n');
        process.exit(0);
    }

    const schemaPath = readFlagValue(args, '--schema');
    const projectRoot = readFlagValue(args, '--projectRoot');
    const controllersGlob = readFlagValue(args, '--controllersGlob');
    const outFile = readFlagValue(args, '--outFile');
    const openapiOut = readFlagValue(args, '--openapiOut');
    const serviceTitle = readFlagValue(args, '--serviceTitle');
    const serverUrl = readFlagValue(args, '--serverUrl');
    const securitySchemeName = readFlagValue(args, '--securitySchemeName');
    const oauthTokenUrl = readFlagValue(args, '--oauthTokenUrl');
    const oauthRefreshUrl = readFlagValue(args, '--oauthRefreshUrl');
    const oauthScopesRaw = readFlagValue(args, '--oauthScopes');
    const omitFieldsRaw = readFlagValue(args, '--omitFields');

    const oauthScopes = oauthScopesRaw ? parseJsonObject(oauthScopesRaw, '--oauthScopes') : undefined;
    const omitFieldsInWriteDtos = omitFieldsRaw ? parseCsv(omitFieldsRaw) : undefined;

    return {
        schemaPath,
        projectRoot,
        controllersGlob,
        outFile,
        openapiOut,
        serviceTitle,
        serverUrl,
        securitySchemeName,
        oauthTokenUrl,
        oauthRefreshUrl,
        oauthScopes,
        omitFieldsInWriteDtos,
    };
}

function mergeConfig(base: Config, parsed: ParsedArgs): Config {
    const cfg: Config = {
        ...base,
        projectRoot: parsed.projectRoot ? path.resolve(process.cwd(), parsed.projectRoot) : base.projectRoot,
        controllersGlob: parsed.controllersGlob ?? base.controllersGlob,
        outFile: parsed.outFile ?? base.outFile,
        openapiOut: parsed.openapiOut ?? base.openapiOut,
        serviceTitle: parsed.serviceTitle ?? base.serviceTitle,
        serverUrl: parsed.serverUrl ?? base.serverUrl,
        securitySchemeName: parsed.securitySchemeName ?? base.securitySchemeName,
        oauth: {
            tokenUrl: parsed.oauthTokenUrl ?? base.oauth.tokenUrl,
            refreshUrl: parsed.oauthRefreshUrl ?? base.oauth.refreshUrl,
            scopes: (parsed.oauthScopes ?? base.oauth.scopes) as Record<string, string>,
        },
        omitFieldsInWriteDtos: parsed.omitFieldsInWriteDtos
            ? new Set(parsed.omitFieldsInWriteDtos)
            : base.omitFieldsInWriteDtos,
    };

    cfg.controllersGlob = ensurePosix(cfg.controllersGlob);
    cfg.outFile = ensurePosix(cfg.outFile);
    cfg.openapiOut = ensurePosix(cfg.openapiOut);

    return cfg;
}

async function loadDmmfFromProject(schemaPath?: string): Promise<Dmmf> {
    const resolvedSchemaPath = schemaPath
        ? path.resolve(process.cwd(), schemaPath)
        : path.resolve(process.cwd(), 'prisma/schema.prisma');

    if (!fs.existsSync(resolvedSchemaPath)) {
        throw new Error(`Prisma schema not found at ${resolvedSchemaPath}`);
    }

    const datamodel = fs.readFileSync(resolvedSchemaPath, 'utf8');
    const require = getRequire();
    const internals = require('@prisma/internals') as any;

    if (typeof internals.getDMMF !== 'function') {
        throw new Error(`@prisma/internals.getDMMF not available`);
    }

    const dmmf = (await internals.getDMMF({ datamodel })) as any;

    if (!dmmf || !dmmf.datamodel || !Array.isArray(dmmf.datamodel.models) || !Array.isArray(dmmf.datamodel.enums)) {
        throw new Error(`Unexpected DMMF shape returned by @prisma/internals.getDMMF`);
    }

    return dmmf as Dmmf;
}

function scalarToSchema(scalar: string): OpenApiSchema {
    switch (scalar) {
        case 'String':
            return { type: 'string' };
        case 'Boolean':
            return { type: 'boolean' };
        case 'Int':
            return { type: 'integer' };
        case 'BigInt':
            return { type: 'integer', format: 'int64' };
        case 'Float':
            return { type: 'number' };
        case 'Decimal':
            return { type: 'number' };
        case 'DateTime':
            return { type: 'string', format: 'date-time' };
        case 'Json':
            return { type: 'object' };
        case 'Bytes':
            return { type: 'string', format: 'byte' };
        default:
            return { type: 'string' };
    }
}

function fieldSchema(field: any, getRefName: (model: string) => string): OpenApiSchema {
    if (field.kind === 'scalar') {
        const base = scalarToSchema(field.type);
        if (field.isList) return { type: 'array', items: base };
        return base;
    }

    if (field.kind === 'enum') {
        const base: OpenApiSchema = { $ref: `#/components/@schemas/${field.type}` };
        if (field.isList) return { type: 'array', items: base };
        return base;
    }

    if (field.kind === 'object') {
        const ref: OpenApiSchema = { $ref: `#/components/@schemas/${getRefName(String(field.type))}` };
        if (field.isList) return { type: 'array', items: ref };
        return ref;
    }

    return { type: 'object' };
}

function modelToGetSchema(model: any, getRefName: (model: string) => string): OpenApiSchema {
    const properties: Record<string, OpenApiSchema> = {};
    const required: string[] = [];

    for (const f of model.fields) {
        properties[f.name] = fieldSchema(f, getRefName);
        if (f.isRequired) required.push(f.name);
    }

    const schema: OpenApiSchema = { type: 'object', properties };
    if (required.length) schema.required = required;
    return schema;
}

function stripWriteFields(model: any, getSchema: OpenApiSchema, omit: Set<string>): OpenApiSchema {
    const schema = JSON.parse(JSON.stringify(getSchema)) as OpenApiSchema;
    if (!schema.properties) return schema;

    const relationFieldNames = new Set(model.fields.filter((f: any) => f.kind === 'object').map((f: any) => f.name));

    for (const key of Object.keys(schema.properties)) {
        if (omit.has(key) || relationFieldNames.has(key)) delete schema.properties[key];
    }

    if (Array.isArray(schema.required)) {
        schema.required = schema.required.filter((k) => !omit.has(k) && !relationFieldNames.has(k));
        if (schema.required.length === 0) delete schema.required;
    }

    return schema;
}

function makeAllOptional(schema: OpenApiSchema): OpenApiSchema {
    const s = JSON.parse(JSON.stringify(schema)) as OpenApiSchema;
    delete s.required;
    return s;
}

function listResponseSchema(itemRef: string): OpenApiSchema {
    return {
        type: 'object',
        properties: {
            count: { type: 'number' },
            hasPreviousPage: { type: 'boolean' },
            hasNextPage: { type: 'boolean' },
            pageNumber: { type: 'number' },
            pageSize: { type: 'number' },
            totalPages: { type: 'number' },
            items: { type: 'array', items: { $ref: itemRef } },
        },
        required: ['count', 'hasPreviousPage', 'hasNextPage', 'pageNumber', 'pageSize', 'totalPages', 'items'],
    };
}

async function buildSchemasFromPrismaDmmf(cfg: Config, schemaPath?: string) {
    const dmmf = await loadDmmfFromProject(schemaPath);
    const schemas: Record<string, OpenApiSchema> = {};
    const getRefName = (modelName: string) => `Get${modelName}Response`;

    for (const e of dmmf.datamodel.enums) {
        schemas[e.name] = { type: 'string', enum: e.values.map((v: any) => v.name) };
    }

    for (const model of dmmf.datamodel.models) {
        const getName = `Get${model.name}Response`;
        const postName = `Post${model.name}Request`;
        const putName = `Put${model.name}Request`;
        const listName = `List${pluralize(model.name)}Response`;

        const getSchema = modelToGetSchema(model, getRefName);
        const postSchema = stripWriteFields(model, getSchema, cfg.omitFieldsInWriteDtos);
        const putSchema = makeAllOptional(postSchema);

        schemas[getName] = getSchema;
        schemas[postName] = postSchema;
        schemas[putName] = putSchema;
        schemas[listName] = listResponseSchema(`#/components/@schemas/${getName}`);
    }

    return schemas;
}

function generateSwaggerConfigJs(cfg: Config, schemas: Record<string, OpenApiSchema>) {
    const routes = globSync(cfg.controllersGlob, { nodir: true }).map((p) => ensurePosix(p));

    const docs = {
        info: { title: cfg.serviceTitle },
        servers: [{ url: cfg.serverUrl }],
        components: {
            "@schemas": schemas,
            securitySchemes: {
                [cfg.securitySchemeName]: {
                    type: 'oauth2',
                    description: 'This API uses OAuth2 with the password flow.',
                    flows: {
                        password: {
                            tokenUrl: cfg.oauth.tokenUrl,
                            refreshUrl: cfg.oauth.refreshUrl,
                            scopes: cfg.oauth.scopes,
                        },
                    },
                },
            },
        },
        security: [{ [cfg.securitySchemeName]: ['openid'] }],
    };

    const fileContent = `const swaggerAutogen = require('swagger-autogen')();
const docs = ${JSON.stringify(docs, null, 2)};
const routes = ${JSON.stringify(routes, null, 2)};
swaggerAutogen('${ensurePosix(cfg.openapiOut)}', routes, docs);`;

    const outPath = path.resolve(cfg.projectRoot, cfg.outFile);
    fs.writeFileSync(outPath, fileContent, 'utf8');
}

export async function run(args: string[] = []) {
    const parsed = parseArgs(args);
    const cfg = mergeConfig(DEFAULT_CONFIG, parsed);
    const schemas = await buildSchemasFromPrismaDmmf(cfg, parsed.schemaPath);
    generateSwaggerConfigJs(cfg, schemas);
}
