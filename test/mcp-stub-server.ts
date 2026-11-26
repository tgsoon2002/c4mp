// Test-only entry: a stdio MCP server over the core with stub tools. Run with ts-node by mcp-server.test.ts.
import { createMcpServer } from '../src/mcp/server';
import { log } from '../src/log';

const server = createMcpServer({
  name: 'stub',
  version: '0.0.1',
  tools: [
    {
      name: 'echo',
      description: 'Echo the text argument',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      handler: (args) => {
        log('stub', 'echo called', args); // console.log under C4PM_DEBUG: must NOT reach stdout
        return String(args.text ?? '');
      },
    },
    {
      name: 'boom',
      description: 'Always throws',
      inputSchema: { type: 'object' },
      handler: () => {
        throw new Error('kaboom');
      },
    },
  ],
});

server.serve(process.stdin, process.stdout).then(
  () => process.exit(0),
  (e) => {
    process.stderr.write(String(e) + '\n');
    process.exit(1);
  },
);
