import { Model } from '../types/llm';

interface ModelsDevProvider {
    id: string;
    name: string;
    models: Record<string, any>;
}

export class ModelRegistry {
    private static API_URL = 'https://models.dev/api.json';
    private static EXCLUDED_PROVIDERS = ['openrouter'];
    private static cache: Map<string, Model[]> = new Map();
    private static providerCache: any[] = [];
    private static lastFetch = 0;
    private static CACHE_TTL = 3600 * 1000; // 1 hour

    static async getModels(forceRefresh = false): Promise<Model[]> {
        if (!forceRefresh && Date.now() - this.lastFetch < this.CACHE_TTL && this.cache.size > 0) {
            return Array.from(this.cache.values()).flat();
        }

        try {
            console.log(`[ModelRegistry] Fetching models from ${this.API_URL}...`);
            const response = await fetch(this.API_URL, {
                headers: {
                    'User-Agent': 'Morphi-Intelligence/1.0.5'
                }
            });

            if (!response.ok) {
                throw new Error(`Failed to fetch models: ${response.statusText}`);
            }

            const data: Record<string, ModelsDevProvider> = await response.json();
            this.cache.clear();

            for (const [providerId, providerData] of Object.entries(data)) {
                if (this.EXCLUDED_PROVIDERS.includes(providerId)) continue;

                const models: Model[] = Object.entries(providerData.models).map(([modelId, m]: [string, any]) => ({
                    id: modelId, // Use the Model ID as suggested
                    name: m.name || modelId,
                    provider: providerId,
                    providerLabel: providerData.name,
                    logo: `https://models.dev/logos/${providerId}.svg`,
                    description: m.description || `${m.limit?.context?.toLocaleString() ?? '?'}k context`,
                    context: m.limit?.context
                }));

                this.cache.set(providerId, models);
            }

            this.providerCache = Object.entries(data)
                .filter(([id]) => !this.EXCLUDED_PROVIDERS.includes(id))
                .map(([id, p]) => ({
                    id,
                    name: p.name,
                    logo: `https://models.dev/logos/${id}.svg`
                }));

            this.lastFetch = Date.now();
            console.log(`[ModelRegistry] Successfully loaded models for ${this.cache.size} providers.`);
            return Array.from(this.cache.values()).flat();
        } catch (error) {
            console.error('[ModelRegistry] Error fetching models:', error);
            return Array.from(this.cache.values()).flat();
        }
    }

    static async getProviders(): Promise<any[]> {
        if (this.providerCache.length === 0 || Date.now() - this.lastFetch > this.CACHE_TTL) {
            await this.getModels();
        }
        return this.providerCache;
    }

    static async getModelsByProvider(providerId: string): Promise<Model[]> {
        if (this.cache.size === 0 || Date.now() - this.lastFetch > this.CACHE_TTL) {
            await this.getModels();
        }
        return this.cache.get(providerId) || [];
    }
}
