import type { PromptBundle } from './profile/resolve.js';
export declare function defaultPromptDir(): string;
export declare function loadPromptBundle(dir?: string): PromptBundle;
export declare function loadModelPromptBundle(dir?: string): PromptBundle;
export declare function promptManifest(dir?: string): {
    prompts: PromptBundle;
    digests: Readonly<Record<"compact" | "lead" | "worker", import("./contracts.js").Digest>>;
};
