import { describe, expect, it } from 'vitest';
import { coerceRecord } from './coerce-record.js';

describe('coerceRecord', () => {
  it('passes an object through unchanged', () => {
    const obj = { confirmDangerous: true };
    expect(coerceRecord(obj, 'args')).toBe(obj);
  });

  it('parses a valid JSON object string', () => {
    expect(coerceRecord('{"confirmDangerous":true}', 'args')).toEqual({
      confirmDangerous: true,
    });
  });

  it('throws on an invalid JSON string', () => {
    expect(() => coerceRecord('{not json}', 'args')).toThrow('not valid');
  });

  it('throws when a JSON string parses to a non-object', () => {
    expect(() => coerceRecord('"just a string"', 'args')).toThrow('not an object');
  });

  it('throws when a JSON string parses to an array', () => {
    expect(() => coerceRecord('[1,2,3]', 'args')).toThrow('an array');
  });

  it('returns {} for undefined (optional args)', () => {
    expect(coerceRecord(undefined, 'args')).toEqual({});
  });

  it('returns {} for null (optional args)', () => {
    expect(coerceRecord(null, 'args')).toEqual({});
  });

  it('throws on a number', () => {
    expect(() => coerceRecord(42, 'args')).toThrow('must be an object');
  });

  it('throws on a boolean', () => {
    expect(() => coerceRecord(true, 'args')).toThrow('must be an object');
  });
});
