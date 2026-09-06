import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { exampleRecipes } from './seeds.js';
import { recipeSchema, type CreateRecipeInput, type QueryTaste, type Recipe } from './schemas.js';

type Row = Omit<Recipe, 'modifiers' | 'tasteKeywords' | 'tags'> & {
  modifiers: string; tasteKeywords: string; tags: string;
};


function decode(row: unknown): Recipe {
  const value = row as Row;
  return recipeSchema.parse({
    ...value,
    modifiers: JSON.parse(value.modifiers),
    tasteKeywords: JSON.parse(value.tasteKeywords),
    tags: JSON.parse(value.tags),
  });
}

export class RecipeStore {
  private readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    try {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('busy_timeout = 5000');
      this.db.pragma('synchronous = FULL');
      const version = this.db.pragma('user_version', { simple: true }) as number;
      if (version > 1) throw new Error('지원하지 않는 데이터베이스 버전입니다.');
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS Recipe (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            baseDrink TEXT NOT NULL,
            modifiers TEXT NOT NULL CHECK (json_valid(modifiers) AND json_type(modifiers) = 'array'),
            tasteKeywords TEXT NOT NULL CHECK (json_valid(tasteKeywords) AND json_type(tasteKeywords) = 'array'),
            tags TEXT NOT NULL CHECK (json_valid(tags) AND json_type(tags) = 'array'),
            description TEXT NOT NULL,
            authorName TEXT NOT NULL,
            likesCount INTEGER NOT NULL DEFAULT 0 CHECK (likesCount >= 0),
            createdAt TEXT NOT NULL,
            source TEXT NOT NULL CHECK (source IN ('example', 'user'))
          ) STRICT;
          CREATE INDEX IF NOT EXISTS recipe_created_at ON Recipe(createdAt DESC);
          CREATE INDEX IF NOT EXISTS recipe_base_drink ON Recipe(baseDrink);
          PRAGMA user_version = 1;
        `);
      })();
      this.seed();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private insert(recipe: Recipe, ignoreExisting = false) {
    this.db.prepare(`INSERT ${ignoreExisting ? 'OR IGNORE' : ''} INTO Recipe
      (id, name, baseDrink, modifiers, tasteKeywords, tags, description, authorName, likesCount, createdAt, source)
      VALUES (@id, @name, @baseDrink, @modifiers, @tasteKeywords, @tags, @description, @authorName, @likesCount, @createdAt, @source)`)
      .run({
        ...recipe,
        modifiers: JSON.stringify(recipe.modifiers),
        tasteKeywords: JSON.stringify(recipe.tasteKeywords),
        tags: JSON.stringify(recipe.tags),
      });
  }

  private seed() {
    const createdAt = new Date().toISOString();
    this.db.transaction(() => {
      exampleRecipes.forEach((recipe, index) => {
        this.insert(recipeSchema.parse({
          ...recipe,
          id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
          authorName: '따바라 예시', likesCount: 0, createdAt, source: 'example',
        }), true);
      });
    })();
  }

  create(input: CreateRecipeInput): Recipe {
    const recipe = recipeSchema.parse({
      ...input, id: randomUUID(), source: 'user', likesCount: 0, createdAt: new Date().toISOString(),
    });
    this.insert(recipe);
    return recipe;
  }

  get(id: string): Recipe | undefined {
    const row = this.db.prepare('SELECT * FROM Recipe WHERE id = ?').get(id);
    return row === undefined ? undefined : decode(row);
  }

  list(options: { tasteKeyword?: QueryTaste; baseDrink?: string; limit: number }): Recipe[] {
    const { where, params } = this.filter(options);
    return this.db.prepare(`SELECT * FROM Recipe ${where} ORDER BY createdAt DESC, rowid DESC LIMIT ?`)
      .all(...params, options.limit).map(decode);
  }

  recommend(tasteKeyword: QueryTaste, limit: number): Recipe[] {
    const { where, params } = this.filter({ tasteKeyword });
    // Always prioritize user submissions. Fill only the remaining slots with examples.
    const order = tasteKeyword === '랜덤' ? 'RANDOM()' : 'likesCount DESC, createdAt DESC, rowid DESC';
    const query = (source: Recipe['source'], count: number) => this.db.prepare(
      `SELECT * FROM Recipe ${where} ${where ? 'AND' : 'WHERE'} source = ? ORDER BY ${order} LIMIT ?`,
    ).all(...params, source, count).map(decode);
    const users = query('user', limit);
    return users.length === limit ? users : [...users, ...query('example', limit - users.length)];
  }

  random(tasteKeyword?: QueryTaste): Recipe | undefined {
    const { where, params } = this.filter(tasteKeyword === undefined ? {} : { tasteKeyword });
    const row = this.db.prepare(`SELECT * FROM Recipe ${where} ORDER BY RANDOM() LIMIT 1`).get(...params);
    return row === undefined ? undefined : decode(row);
  }

  private filter(options: { tasteKeyword?: QueryTaste; baseDrink?: string }) {
    const clauses: string[] = [];
    const params: string[] = [];
    if (options.tasteKeyword !== undefined && options.tasteKeyword !== '랜덤') {
      clauses.push('EXISTS (SELECT 1 FROM json_each(Recipe.tasteKeywords) WHERE value = ?)');
      params.push(options.tasteKeyword);
    }
    if (options.baseDrink !== undefined) {
      clauses.push('baseDrink = ?');
      params.push(options.baseDrink);
    }
    return { where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params };
  }

  close() {
    if (this.db.open) this.db.close();
  }
}
