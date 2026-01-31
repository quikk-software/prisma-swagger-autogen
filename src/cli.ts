#!/usr/bin/env node
import { run } from './index';

void run(process.argv.slice(2)).catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
});
