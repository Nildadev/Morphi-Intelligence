import { useState } from 'react';
import { Globe } from './icons';
import anthropicLogo from '../assets/providers/anthropic.svg';
import cerebrasLogo from '../assets/providers/cerebras.svg';
import deepinfraLogo from '../assets/providers/deepinfra.svg';
import deepseekLogo from '../assets/providers/deepseek.svg';
import fireworksLogo from '../assets/providers/fireworks-ai.svg';
import googleLogo from '../assets/providers/google.svg';
import groqLogo from '../assets/providers/groq.svg';
import kiloLogo from '../assets/providers/kilo.svg';
import mistralLogo from '../assets/providers/mistral.svg';
import nvidiaLogo from '../assets/providers/nvidia.svg';
import openaiLogo from '../assets/providers/openai.svg';
import openrouterLogo from '../assets/providers/openrouter.svg';
import perplexityLogo from '../assets/providers/perplexity.svg';
import togetheraiLogo from '../assets/providers/togetherai.svg';
import xaiLogo from '../assets/providers/xai.svg';

export interface ProviderLogoProps {
    /** Provider id from `GET /api/providers` / `ModelInfo.provider`; labels are resolved as a fallback. */
    provider: string;
    /** Display name; used for the accessible label when provided. */
    name?: string;
    size?: number;
}

/**
 * Provider marks are Models.dev's official SVGs, now bundled locally so slow/internet-less startup
 * never waits on a remote logo. The API metadata endpoint is `https://models.dev/api.json`, and
 * the public logo endpoint is `https://models.dev/logos/<provider-id>.svg`; these files were copied
 * from there into `src/assets/providers` and bundled by Vite.
 */
const LOCAL_LOGO_BY_PROVIDER: Record<string, string> = {
    google: googleLogo,
    openai: openaiLogo,
    anthropic: anthropicLogo,
    openrouter: openrouterLogo,
    deepseek: deepseekLogo,
    groq: groqLogo,
    mistral: mistralLogo,
    xai: xaiLogo,
    cerebras: cerebrasLogo,
    together: togetheraiLogo,
    fireworks: fireworksLogo,
    perplexity: perplexityLogo,
    deepinfra: deepinfraLogo,
    // NVIDIA NIM and Kilo Gateway come from the models.dev logo set like the rest.
    nvidia: nvidiaLogo,
    kilo: kiloLogo,
    // The local DeepSeek bridge reuses the same DeepSeek mark — one brand, two endpoints
    // (nvidia api.deepseek.com vs the user's own 127.0.0.1:8000).
    'deepseek-chat': deepseekLogo,
};

export function ProviderLogo({ provider, name, size = 26 }: ProviderLogoProps) {
    const [failed, setFailed] = useState(false);
    const id = provider.trim().toLowerCase();
    const logoSrc = LOCAL_LOGO_BY_PROVIDER[id];
    const label = name ?? provider;

    if (failed || logoSrc === undefined) {
        return (
            <span
                role="img"
                aria-label={label}
                title={label}
                className="flex shrink-0 items-center justify-center rounded-lg bg-bg-inset text-text-secondary"
                style={{ width: size, height: size }}
            >
                <Globe size={size * 0.58} aria-hidden="true" />
            </span>
        );
    }

    return (
        <span
            role="img"
            aria-label={label}
            title={label}
            className="flex shrink-0 items-center justify-center rounded-lg bg-white p-[2px]"
            style={{ width: size, height: size }}
        >
            <img
                src={logoSrc}
                alt=""
                width={size - 4}
                height={size - 4}
                draggable={false}
                onError={() => setFailed(true)}
                className="h-full w-full object-contain"
            />
        </span>
    );
}
