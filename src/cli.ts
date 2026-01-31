import { run } from './index';

run(process.argv.slice(2)).catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
});
