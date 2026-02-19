// Skylight meal planning operations.
// Covers recipes (the persistent recipe box) and meal sittings (scheduled meals on the calendar).
// Requires a Skylight Plus subscription.

import type { SkylightClient } from '../client.js';
import type {
  JsonApiResponse,
  SkylightMealCategory,
  SkylightMealCategoryAttributes,
  SkylightMealSitting,
  SkylightMealSittingAttributes,
  SkylightRecipe,
  SkylightRecipeAttributes,
} from '../types.js';

const FRAME_PATH = '/api/frames/{frameId}';

// --- Meal categories (Breakfast, Lunch, Dinner, Snack) ---

export async function getMealCategories(client: SkylightClient): Promise<SkylightMealCategory[]> {
  const response = await client.get<JsonApiResponse<SkylightMealCategoryAttributes>>(
    `${FRAME_PATH}/meals/categories`
  );
  const data = Array.isArray(response.data) ? response.data : [response.data];
  return data as SkylightMealCategory[];
}

// --- Recipe box ---

export async function getAllRecipes(client: SkylightClient): Promise<SkylightRecipe[]> {
  const response = await client.get<JsonApiResponse<SkylightRecipeAttributes>>(
    `${FRAME_PATH}/meals/recipes`,
    { include: 'meal_category' }
  );
  const data = Array.isArray(response.data) ? response.data : [response.data];
  return data as SkylightRecipe[];
}

export async function createRecipe(
  client: SkylightClient,
  summary: string,
  mealCategoryId: string,
  description: string = ''
): Promise<SkylightRecipe> {
  const body = {
    summary,
    description,
    meal_category_id: mealCategoryId,
  };

  const response = await client.post<unknown>(
    `${FRAME_PATH}/meals/recipes`,
    body
  );
  console.log('[DEBUG] createRecipe response:', JSON.stringify(response));
  return (response as JsonApiResponse<SkylightRecipeAttributes>).data as SkylightRecipe;
}

export async function deleteRecipe(client: SkylightClient, recipeId: string): Promise<void> {
  await client.delete(`${FRAME_PATH}/meals/recipes/${recipeId}`);
}

// --- Meal sittings (scheduled meals on the calendar) ---

// date_max is exclusive in the Skylight API, so we add 1 day to include the end date.
export async function getMealSittings(
  client: SkylightClient,
  dateMin: string,
  dateMax: string
): Promise<SkylightMealSitting[]> {
  // Add 1 day to dateMax because Skylight's date_max is exclusive
  const exclusiveDateMax = addOneDay(dateMax);

  const response = await client.get<JsonApiResponse<SkylightMealSittingAttributes>>(
    `${FRAME_PATH}/meals/sittings`,
    { date_min: dateMin, date_max: exclusiveDateMax }
  );
  const data = Array.isArray(response.data) ? response.data : [response.data];
  return data as SkylightMealSitting[];
}

export async function scheduleMeal(
  client: SkylightClient,
  date: string,
  mealCategoryId: string,
  recipeId: string | null = null
): Promise<SkylightMealSitting> {
  const body: Record<string, unknown> = {
    date,
    meal_category_id: mealCategoryId,
  };
  if (recipeId) {
    body['meal_recipe_id'] = recipeId;
  }

  const response = await client.post<unknown>(
    `${FRAME_PATH}/meals/sittings`,
    body
  );
  console.log('[DEBUG] scheduleMeal response:', JSON.stringify(response));
  return (response as JsonApiResponse<SkylightMealSittingAttributes>).data as SkylightMealSitting;
}

export async function deleteMealSitting(
  client: SkylightClient,
  sittingId: string
): Promise<void> {
  await client.delete(`${FRAME_PATH}/meals/sittings/${sittingId}`);
}

// --- Helper ---

function addOneDay(dateStr: string): string {
  const date = new Date(dateStr);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10); // returns YYYY-MM-DD
}
