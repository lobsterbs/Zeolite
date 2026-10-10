import { describe, it, expect, beforeEach } from 'vitest';
import { loadEnter, loadLeave, loadInflight, loadResetForTests } from '../loadstate';

describe('loadstate', () => {
  beforeEach(() => loadResetForTests());

  it('counts per host and settles on leave', () => {
    loadEnter('https://example.com/a');
    loadEnter('https://example.com/b');
    loadEnter('https://other.test/x');
    expect(loadInflight('example.com')).toBe(2);
    expect(loadInflight('other.test')).toBe(1);
    expect(loadInflight()).toBe(3);
    loadLeave('https://example.com/a');
    expect(loadInflight('example.com')).toBe(1);
    loadLeave('https://example.com/b');
    loadLeave('https://other.test/x');
    expect(loadInflight()).toBe(0);
  });

  it('ignores non-absolute destinations and never goes negative', () => {
    loadEnter('/relative/path');
    loadEnter('not a url');
    expect(loadInflight()).toBe(0);
    loadLeave('https://never-entered.test/a');
    loadLeave('https://never-entered.test/a');
    expect(loadInflight('never-entered.test')).toBe(0);
    expect(loadInflight()).toBe(0);
  });

  it('reset drops all accounting', () => {
    loadEnter('https://a.test/1');
    loadEnter('https://b.test/1');
    loadResetForTests();
    expect(loadInflight()).toBe(0);
    expect(loadInflight('a.test')).toBe(0);
  });
});