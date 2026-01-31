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

const CONFIG = {
    projectRoot: process.cwd(),
    controllersGlob: './src/web/api/controllers/**/*.ts',
    outFile: './swagger.config.js',
    openapiOut: './src/web/api/openapi.json',
    serviceTitle: 'Prescription Service',
    serverUrl: 'http://localhost:3008',
    securitySchemeName: 'keycloakOAuth',
    oauth: {
        tokenUrl: 'http://auth.localhost/realms/haemo/protocol/openid-connect/token',
        refreshUrl: 'http://auth.localhost/realms/haemo/protocol/openid-connect/refresh',
        scopes: { openid: 'openid scope' as const },
    },
    omitFieldsInWriteDtos: new Set(['id', 'createdAt', 'updatedAt', 'v']),
};

function ensurePosix(p: string) {
    return p.split(path.sep).join(path.posix.sep);
}

function pluralize(name: string) {
    if (name.endsWith('s')) return `${name}es`;
    return `${name}s`;
}

function getRequire() {
    const base = typeof __filename !== 'undefined' ? __filename : (import.meta as any).url;
    return createRequire(base);
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
        const base: OpenApiSchema = { $ref: `#/components/schemas/${field.type}` };
        if (field.isList) return { type: 'array', items: base };
        return base;
    }

    if (field.kind === 'object') {
        const ref: OpenApiSchema = { $ref: `#/components/schemas/${getRefName(String(field.type))}` };
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
        if (omit.has(key) || relationFieldNames.has(key)) {
            delete schema.properties[key];
        }
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

async function buildSchemasFromPrismaDmmf(schemaPath?: string) {
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
        const postSchema = stripWriteFields(model, getSchema, CONFIG.omitFieldsInWriteDtos);
        const putSchema = makeAllOptional(postSchema);

        schemas[getName] = getSchema;
        schemas[postName] = postSchema;
        schemas[putName] = putSchema;
        schemas[listName] = listResponseSchema(`#/components/schemas/${getName}`);
    }

    return schemas;
}

function generateSwaggerConfigJs(schemas: Record<string, OpenApiSchema>) {
    const routes = globSync(CONFIG.controllersGlob, { nodir: true }).map((p) => ensurePosix(p));

    const docs = {
        info: { title: CONFIG.serviceTitle },
        servers: [{ url: CONFIG.serverUrl }],
        components: {
            schemas,
            securitySchemes: {
                [CONFIG.securitySchemeName]: {
                    type: 'oauth2',
                    description: 'This API uses OAuth2 with the password flow.',
                    flows: {
                        password: {
                            tokenUrl: CONFIG.oauth.tokenUrl,
                            refreshUrl: CONFIG.oauth.refreshUrl,
                            scopes: CONFIG.oauth.scopes,
                        },
                    },
                },
            },
        },
        security: [{ [CONFIG.securitySchemeName]: ['openid'] }],
    };

    const fileContent = `const swaggerAutogen = require('swagger-autogen')();
const docs = ${JSON.stringify(docs, null, 2)};
const routes = ${JSON.stringify(routes, null, 2)};
swaggerAutogen('${ensurePosix(CONFIG.openapiOut)}', routes, docs);`;

    fs.writeFileSync(path.resolve(CONFIG.projectRoot, CONFIG.outFile), fileContent, 'utf8');
}

export async function run(args: string[] = []) {
    const schemaFlagIndex = args.findIndex((a) => a === '--schema');
    const schemaPath = schemaFlagIndex >= 0 ? args[schemaFlagIndex + 1] : undefined;
    const schemas = await buildSchemasFromPrismaDmmf(schemaPath);
    generateSwaggerConfigJs(schemas);
}
