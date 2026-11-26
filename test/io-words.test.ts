import { ioContainerWord, routeMethod } from '../src/plan/ioWords';

// b266: the one table of IO words: app word by technology, route method.
describe('ioContainerWord', () => {
  it.each([
    ['Node / commander', 'CLI'], ['Python click', 'CLI'], ['yargs', 'CLI'], ['My CLI', 'CLI'],
    ['Express', 'API'], ['Fastify', 'API'], ['Hono', 'API'], ['REST', 'API'], ['HTTP / OpenAPI', 'API'], ['Node API', 'API'],
    ['MCP server', 'MCP'], ['TypeScript / MCP', 'MCP'],
    ['React', 'App'], ['', 'App'], [null, 'App'], [undefined, 'App'], ['toString', 'App'],
  ])('%s -> %s', (tech, word) => {
    expect(ioContainerWord(tech)).toBe(word);
  });
});

describe('routeMethod', () => {
  it.each([
    ['GET /orders/:id', undefined, 'GET'], ['post /orders', undefined, 'POST'], ['/orders', undefined, null], ['Orders', undefined, null],
    ['/orders', { method: 'patch' }, 'PATCH'], ['GET /x', { method: 'DELETE' }, 'DELETE'], ['', undefined, null],
  ])('%s %j -> %s', (title, metadata, method) => {
    expect(routeMethod(title, metadata)).toBe(method);
  });
});
