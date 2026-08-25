import { fixtureData } from './fixtures';
import type { BenchData } from './types';

/**
 * The swap point.
 *
 * Every page reads `data`. When the indexer and shadow engine are serving over
 * HTTP, this file returns an HTTP-backed `BenchData` instead of the fixtures
 * and nothing else in the app changes.
 */
export const data: BenchData = fixtureData;

export type * from './types';
