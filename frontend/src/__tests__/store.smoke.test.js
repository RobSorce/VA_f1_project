import { describe, it, expect } from 'vitest';
import { useF1Store } from '../store/useF1Store.js';

describe('store', () => {
  it('imports and initialises under node', () => {
    expect(useF1Store.getState().currentLap).toBe(1);
  });
});
