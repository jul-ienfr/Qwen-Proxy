/**
 * Model Mapper - Custom mapping system for model routing
 * Inspired by OpenCode-Proxy's flexible model mapping
 */

import fs from 'fs';
import path from 'path';
import { config } from './config.js';
import { getDebugLogger } from './debug-logger.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ModelMapping {
  /** Source model (e.g., "gpt-4", "claude-3-opus") */
  source: string;
  /** Target Qwen model (e.g., "qwen-plus", "qwen-turbo") */
  target: string;
  /** Enable/disable this mapping */
  enabled: boolean;
  /** Force thinking mode (auto/disabled/adaptive) */
  thinkingMode?: 'auto' | 'disabled' | 'adaptive';
  /** Force effort level */
  effortLevel?: 'auto' | 'low' | 'medium' | 'high';
}

export interface CustomRoute {
  /** Unique route ID */
  id: string;
  /** Match patterns (e.g., ["nimo", "mimo-*"]) */
  match: string[];
  /** Target model */
  targetModel: string;
  /** Enable/disable this route */
  enabled: boolean;
  /** Priority (higher = more priority) */
  priority: number;
  /** Force thinking mode */
  thinkingMode?: 'auto' | 'disabled' | 'adaptive';
  /** Force effort level */
  effortLevel?: 'auto' | 'low' | 'medium' | 'high';
  /** Creation timestamp */
  createdAt: number;
  /** Last update timestamp */
  updatedAt: number;
}

export interface MapperConfig {
  /** Standard model mappings */
  modelMappings: ModelMapping[];
  /** Custom routes */
  customRoutes: CustomRoute[];
  /** Disable auto-mapping */
  disableAutoMapping: boolean;
  /** Model aliases */
  aliases: Record<string, string>;
}

export interface ResolveResult {
  /** Target model to use */
  targetModel: string;
  /** Thinking mode override */
  thinkingMode?: 'auto' | 'disabled' | 'adaptive';
  /** Effort level override */
  effortLevel?: 'auto' | 'low' | 'medium' | 'high';
  /** How this route was matched */
  matchedBy: 'custom-route' | 'mapping' | 'alias' | 'passthrough';
  /** Route ID if matched by custom route */
  routeId?: string;
}

// ─── Default Config ──────────────────────────────────────────────────────────

const DEFAULT_CONFIG: MapperConfig = {
  modelMappings: [],
  customRoutes: [],
  disableAutoMapping: false,
  aliases: {},
};

// ─── ModelMapper Class ───────────────────────────────────────────────────────

export class ModelMapper {
  private config: MapperConfig = { ...DEFAULT_CONFIG };
  private configPath: string;
  private lastModified: number = 0;

  constructor() {
    this.configPath = config.mapping?.configFile || './config/model-mapping.json';
    this.loadConfig();
  }

  /**
   * Load configuration from file
   */
  loadConfig(): void {
    try {
      if (fs.existsSync(this.configPath)) {
        const content = fs.readFileSync(this.configPath, 'utf-8');
        const parsed = JSON.parse(content);
        this.config = { ...DEFAULT_CONFIG, ...parsed };
        this.lastModified = fs.statSync(this.configPath).mtimeMs;
        console.log(`[ModelMapper] Loaded config from ${this.configPath}`);
      } else {
        // Create default config file
        this.saveConfig();
        console.log(`[ModelMapper] Created default config at ${this.configPath}`);
      }
    } catch (err: any) {
      console.error(`[ModelMapper] Failed to load config: ${err.message}`);
      this.config = { ...DEFAULT_CONFIG };
    }
  }

  /**
   * Save configuration to file
   */
  saveConfig(): void {
    try {
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8');
      this.lastModified = Date.now();
    } catch (err: any) {
      console.error(`[ModelMapper] Failed to save config: ${err.message}`);
    }
  }

  /**
   * Check if config file has been modified and reload if needed
   */
  checkForReload(): boolean {
    try {
      if (!fs.existsSync(this.configPath)) return false;
      const currentMtime = fs.statSync(this.configPath).mtimeMs;
      if (currentMtime > this.lastModified) {
        this.loadConfig();
        return true;
      }
    } catch {
      // Ignore errors
    }
    return false;
  }

  /**
   * Resolve target model for a requested model
   */
  resolve(
    requestedModel: string,
    metadata?: {
      tools?: any[];
      thinking?: boolean;
      effort?: string;
    }
  ): ResolveResult {
    let result: ResolveResult;

    // 1. Check custom routes (by priority, highest first)
    const sortedRoutes = [...this.config.customRoutes]
      .filter(r => r.enabled)
      .sort((a, b) => b.priority - a.priority);

    for (const route of sortedRoutes) {
      if (this.matchesRoute(requestedModel, route)) {
        result = {
          targetModel: route.targetModel,
          thinkingMode: route.thinkingMode,
          effortLevel: route.effortLevel,
          matchedBy: 'custom-route',
          routeId: route.id,
        };
        this.logResolution(requestedModel, result);
        return result;
      }
    }

    // 2. Check explicit model mappings
    const mapping = this.config.modelMappings.find(
      m => m.enabled && m.source.toLowerCase() === requestedModel.toLowerCase()
    );
    if (mapping) {
      result = {
        targetModel: mapping.target,
        thinkingMode: mapping.thinkingMode,
        effortLevel: mapping.effortLevel,
        matchedBy: 'mapping',
      };
      this.logResolution(requestedModel, result);
      return result;
    }

    // 3. Check aliases
    const aliasKey = requestedModel.toLowerCase();
    if (this.config.aliases[aliasKey]) {
      result = {
        targetModel: this.config.aliases[aliasKey],
        matchedBy: 'alias',
      };
      this.logResolution(requestedModel, result);
      return result;
    }

    // 4. Pass-through (use original model)
    result = {
      targetModel: requestedModel,
      matchedBy: 'passthrough',
    };
    this.logResolution(requestedModel, result);
    return result;
  }

  private logResolution(requestedModel: string, result: ResolveResult): void {
    const dbg = getDebugLogger();
    if (dbg.isEnabled()) {
      dbg.log('MAPPING', 'model-mapper.ts', `Resolved: ${requestedModel} → ${result.targetModel} (${result.matchedBy})`, {
        requestedModel,
        targetModel: result.targetModel,
        matchedBy: result.matchedBy,
        routeId: result.routeId,
      });
    }
  }

  /**
   * Check if a model matches a custom route
   */
  private matchesRoute(model: string, route: CustomRoute): boolean {
    const modelLower = model.toLowerCase();
    return route.match.some(pattern => {
      const patternLower = pattern.toLowerCase();
      // Exact match
      if (modelLower === patternLower) return true;
      // Wildcard match (e.g., "qwen-*" matches "qwen-plus")
      if (patternLower.endsWith('-*')) {
        const prefix = patternLower.slice(0, -2);
        return modelLower.startsWith(prefix);
      }
      // Contains match
      if (patternLower.startsWith('*') && patternLower.endsWith('*')) {
        const inner = patternLower.slice(1, -1);
        return modelLower.includes(inner);
      }
      // Starts with
      if (patternLower.endsWith('*')) {
        const prefix = patternLower.slice(0, -1);
        return modelLower.startsWith(prefix);
      }
      // Ends with
      if (patternLower.startsWith('*')) {
        const suffix = patternLower.slice(1);
        return modelLower.endsWith(suffix);
      }
      return false;
    });
  }

  // ─── Getters ──────────────────────────────────────────────────────────────

  getConfig(): MapperConfig {
    return { ...this.config };
  }

  getMappings(): ModelMapping[] {
    return [...this.config.modelMappings];
  }

  getRoutes(): CustomRoute[] {
    return [...this.config.customRoutes];
  }

  getAliases(): Record<string, string> {
    return { ...this.config.aliases };
  }

  // ─── Setters ──────────────────────────────────────────────────────────────

  setConfig(config: Partial<MapperConfig>): void {
    this.config = { ...this.config, ...config };
    this.saveConfig();
  }

  addMapping(mapping: ModelMapping): void {
    const existing = this.config.modelMappings.findIndex(
      m => m.source.toLowerCase() === mapping.source.toLowerCase()
    );
    if (existing >= 0) {
      this.config.modelMappings[existing] = mapping;
    } else {
      this.config.modelMappings.push(mapping);
    }
    this.saveConfig();
  }

  removeMapping(source: string): boolean {
    const index = this.config.modelMappings.findIndex(
      m => m.source.toLowerCase() === source.toLowerCase()
    );
    if (index >= 0) {
      this.config.modelMappings.splice(index, 1);
      this.saveConfig();
      return true;
    }
    return false;
  }

  addRoute(route: Omit<CustomRoute, 'id' | 'createdAt' | 'updatedAt'>): CustomRoute {
    const newRoute: CustomRoute = {
      ...route,
      id: `route_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.config.customRoutes.push(newRoute);
    this.saveConfig();
    return newRoute;
  }

  updateRoute(id: string, updates: Partial<CustomRoute>): boolean {
    const index = this.config.customRoutes.findIndex(r => r.id === id);
    if (index >= 0) {
      this.config.customRoutes[index] = {
        ...this.config.customRoutes[index],
        ...updates,
        updatedAt: Date.now(),
      };
      this.saveConfig();
      return true;
    }
    return false;
  }

  removeRoute(id: string): boolean {
    const index = this.config.customRoutes.findIndex(r => r.id === id);
    if (index >= 0) {
      this.config.customRoutes.splice(index, 1);
      this.saveConfig();
      return true;
    }
    return false;
  }

  addAlias(alias: string, target: string): void {
    this.config.aliases[alias.toLowerCase()] = target;
    this.saveConfig();
  }

  removeAlias(alias: string): boolean {
    const key = alias.toLowerCase();
    if (this.config.aliases[key]) {
      delete this.config.aliases[key];
      this.saveConfig();
      return true;
    }
    return false;
  }

  /**
   * Force reload config from file
   */
  reload(): void {
    this.loadConfig();
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

export const modelMapper = new ModelMapper();
