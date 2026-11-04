import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blocks, companyHosts, rewrite, check, IMPORT_LINE } from './caddy-main.mjs';

const site = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../deploy/caddy/agent-company.caddy'), 'utf8');
const hosts = companyHosts(site);

const main = `{
	email ops@example.com
}

desk.example.com {
	reverse_proxy https://127.0.0.1:5901 {
		transport http {
			tls_insecure_skip_verify
		}
	}
}

# a comment about the server, not about a block


# old company block, hand-written
app.hq.example.com {
	handle /x/* {
		redir {uri} 301
	}
	respond "a { brace in a string"
}

k8s.example.com {
	@authed header Authorization "Bearer x"   # with } in a comment
	respond 403
}
api.hq.example.com {
	reverse_proxy 127.0.0.1:7420
}
`;

test('the company hosts come from deploy/caddy/agent-company.caddy', () => {
  assert.deepEqual([...hosts].sort(), ['api.hq.example.com', 'app.hq.example.com', 'art.hq.example.com', 'tab.hq.example.com']);
});

test('rewrite drops only company blocks (and their comments), keeps the rest, adds one import', () => {
  const out = rewrite(main, hosts);
  assert.ok(!out.includes('app.hq.') && !out.includes('api.hq.') && !out.includes('hand-written'));
  assert.ok(out.includes('desk.example.com {') && out.includes('tls_insecure_skip_verify') && out.includes('k8s.example.com {'));
  assert.ok(out.includes('# a comment about the server, not about a block\n\n\n'), 'unrelated text untouched');
  assert.ok(out.includes('email ops@example.com'), 'global options kept');
  assert.equal(out.split('\n').filter((l) => l === IMPORT_LINE).length, 1);
  assert.ok(out.endsWith(`\n\n${IMPORT_LINE}\n`));
  assert.equal(rewrite(out, hosts), out, 'idempotent');
  assert.deepEqual(blocks(out).map((b) => b.addresses[0]), [undefined, 'desk.example.com', 'k8s.example.com']);
});

test('check names what is wrong, and is quiet on a rewritten file', () => {
  assert.match(check(main, hosts) ?? '', /app\.hq\.example\.com.*api\.hq|appears 0 times/);
  assert.equal(check(rewrite(main, hosts), hosts), null);
  assert.match(check(`${rewrite(main, hosts)}${IMPORT_LINE}\n`, hosts) ?? '', /appears 2 times/);
});

test('https:// and :443 spellings of a company host are the same site', () => {
  const out = rewrite('https://api.hq.example.com:443 {\n\trespond x\n}\n\ndesk.example.com {\n\trespond d\n}\n', hosts);
  assert.ok(!out.includes('api.hq') && out.includes('desk.example.com {'));
});

test('a block shared with another host is refused, not half-removed', () => {
  assert.throws(() => rewrite('app.hq.example.com, desk.example.com {\n\trespond x\n}\n', hosts), /split it by hand/);
});

test('unbalanced braces are refused, never guessed', () => {
  assert.throws(() => rewrite('a.example.com {\n\trespond hi\n', hosts), /unbalanced/);
});
