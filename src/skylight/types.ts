// TypeScript types for the Skylight API responses.
// Skylight uses the JSON:API format, which wraps everything in { data, included, meta }.

// --- JSON:API envelope types ---

export interface JsonApiResource<TAttributes> {
  id: string;
  type: string;
  attributes: TAttributes;
  relationships?: Record<string, { data: JsonApiRef | JsonApiRef[] }>;
}

export interface JsonApiRef {
  id: string;
  type: string;
}

export interface JsonApiResponse<TAttributes> {
  data: JsonApiResource<TAttributes> | JsonApiResource<TAttributes>[];
  included?: JsonApiResource<Record<string, unknown>>[];
  meta?: Record<string, unknown>;
}

// --- Skylight shopping list types ---

export interface SkylightListAttributes {
  label: string;
  kind: 'shopping' | 'to_do';
  color: string | null;
  default_grocery_list: boolean;
}

export interface SkylightListItemAttributes {
  label: string;
  // "pending" means not checked off; "completed" means checked off
  status: 'pending' | 'completed';
  // Grocery category (e.g. "Dairy", "Produce") — may be null
  section: string | null;
}

export type SkylightList = JsonApiResource<SkylightListAttributes>;
export type SkylightListItem = JsonApiResource<SkylightListItemAttributes>;

// --- Skylight meal planning types ---

export interface SkylightMealCategoryAttributes {
  name: string; // e.g. "Breakfast", "Lunch", "Dinner", "Snack"
}

export interface SkylightRecipeAttributes {
  summary: string;       // recipe name
  description: string;   // full recipe text / ingredient list
  meal_category_id: string;
}

export interface SkylightMealSittingAttributes {
  date: string;          // YYYY-MM-DD
  meal_time: string;     // category name, e.g. "Dinner"
  meal_recipe_id: string | null;
}

export type SkylightMealCategory = JsonApiResource<SkylightMealCategoryAttributes>;
export type SkylightRecipe = JsonApiResource<SkylightRecipeAttributes>;
export type SkylightMealSitting = JsonApiResource<SkylightMealSittingAttributes>;

// --- Convenience: a list with its items already resolved ---

export interface SkylightListWithItems {
  list: SkylightList;
  items: SkylightListItem[];
}
