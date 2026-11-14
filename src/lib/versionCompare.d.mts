/**
 * Types for `versionCompare.mjs`, which is plain JavaScript so `node --test` can execute it.
 *
 * See that file for why: it has an arithmetic bug worth catching, and a test that cannot run the code can
 * only assert it exists.
 */
export declare function compareVersions(left: string, right: string): number;
