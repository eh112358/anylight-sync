// Skylight shopping list operations.
// Each function is a thin wrapper around the HTTP client — no business logic here.
// Business logic (diffing, deciding what to create/update/delete) lives in src/sync/.

import type { SkylightClient } from '../client.js';
import type {
  JsonApiResponse,
  SkylightList,
  SkylightListAttributes,
  SkylightListItem,
  SkylightListItemAttributes,
  SkylightListWithItems,
} from '../types.js';

const FRAME_PATH = '/api/frames/{frameId}';

// --- List operations ---

export async function getAllLists(client: SkylightClient): Promise<SkylightList[]> {
  const response = await client.get<JsonApiResponse<SkylightListAttributes>>(`${FRAME_PATH}/lists`);
  const data = Array.isArray(response.data) ? response.data : [response.data];
  return data as SkylightList[];
}

// Fetches a single list and resolves its items from the "included" sideload.
export async function getListWithItems(
  client: SkylightClient,
  listId: string
): Promise<SkylightListWithItems> {
  const response = await client.get<JsonApiResponse<SkylightListAttributes>>(
    `${FRAME_PATH}/lists/${listId}`,
    { include: 'list_items' }
  );

  const list = response.data as SkylightList;

  // Items are returned in the "included" array, not nested inside the list
  const items = (response.included ?? []).filter(
    (resource) => resource.type === 'list_item'
  ) as unknown as SkylightListItem[];

  return { list, items };
}

export async function createList(
  client: SkylightClient,
  label: string
): Promise<SkylightList> {
  const body = {
    data: {
      type: 'list',
      attributes: {
        label,
        kind: 'shopping',
        color: null,
      } satisfies Partial<SkylightListAttributes>,
    },
  };

  const response = await client.post<JsonApiResponse<SkylightListAttributes>>(
    `${FRAME_PATH}/lists`,
    body
  );
  return response.data as SkylightList;
}

// --- List item operations ---

export async function addItem(
  client: SkylightClient,
  listId: string,
  label: string,
  section: string | null = null
): Promise<SkylightListItem> {
  // Note: despite the JSON:API format used everywhere else, the Skylight list item
  // creation endpoint expects a flat body — just { label } at the top level.
  // The section field is included only when present (the API ignores null values poorly).
  const body: Record<string, string> = { label };
  if (section !== null) {
    body['section'] = section;
  }

  const response = await client.post<JsonApiResponse<SkylightListItemAttributes>>(
    `${FRAME_PATH}/lists/${listId}/list_items`,
    body
  );
  return response.data as SkylightListItem;
}

export async function updateItem(
  client: SkylightClient,
  listId: string,
  itemId: string,
  changes: Partial<SkylightListItemAttributes>
): Promise<SkylightListItem> {
  // Same as addItem — Skylight expects a flat body, not a JSON:API wrapper
  const response = await client.put<JsonApiResponse<SkylightListItemAttributes>>(
    `${FRAME_PATH}/lists/${listId}/list_items/${itemId}`,
    changes
  );
  return response.data as SkylightListItem;
}

export async function deleteItem(
  client: SkylightClient,
  listId: string,
  itemId: string
): Promise<void> {
  await client.delete(`${FRAME_PATH}/lists/${listId}/list_items/${itemId}`);
}
