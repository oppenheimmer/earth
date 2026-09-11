import assert from "node:assert/strict";
import {test} from "node:test";
import {execFile} from "node:child_process";
import {promisify} from "node:util";

test("malformed paths return 400 without terminating the test server", async () => {
    // Isolate a potential unhandled rejection so it cannot terminate this runner.
    const env = {...process.env};
    delete env.NODE_TEST_CONTEXT;
    const result = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
        import assert from 'node:assert/strict';
        import {serve} from './test/lib/serve.mjs';
        const server = await serve('public');
        const root = 'http://127.0.0.1:' + server.port;
        try {
            for (const path of ['/%', '/%GG', '/%C0%AF', '/%00']) {
                assert.equal((await fetch(root + path)).status, 400, path);
            }
            assert.equal((await fetch(root + '/')).status, 200);
        } finally { await server.close(); }
    `], {env, timeout: 10000});
    assert.equal(result.stderr, "");
});
