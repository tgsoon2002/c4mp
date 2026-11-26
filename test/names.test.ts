import { toId, toDisplayName } from '../src/names';

describe('toId', () => {
  it('should transform names according to the spec', () => {
    expect(toId('orderService')).toBe('order-service');
    expect(toId('api-getway')).toBe('api-getway');
    expect(toId('Task Service')).toBe('task-service');
    expect(toId('task_service')).toBe('task-service');
    expect(toId('@scope/pkg')).toBe('scope-pkg');
    expect(toId('HTTPServer')).toBe('httpserver');
    expect(toId('services')).toBe('services');
    expect(toId('')).toBe('unnamed');
  });
});

describe('toDisplayName', () => {
  it('should transform names according to the spec', () => {
    expect(toDisplayName('orderService')).toBe('Order Service');
    expect(toDisplayName('api-getway')).toBe('Api Getway');
    expect(toDisplayName('Task Service')).toBe('Task Service');
    expect(toDisplayName('task_service')).toBe('Task Service');
    expect(toDisplayName('@scope/pkg')).toBe('Scope Pkg');
    expect(toDisplayName('HTTPServer')).toBe('HTTPServer');
    expect(toDisplayName('services')).toBe('Services');
    expect(toDisplayName('')).toBe('Unnamed');
  });
});
