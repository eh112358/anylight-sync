// Wrapper around the 'anylist' npm package.
// Provides a clean, typed interface for everything we need from AnyList.
// Hides the quirks of the underlying package (dynamic imports, untyped objects, etc.)

// The anylist package uses CommonJS with no TypeScript types, so we import it
// with require and tell TypeScript to treat it as 'any'.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AnyList = require('anylist');

import { logger } from '../utils/logger.js';
import type { AnyListItem, AnyListList, AnyListMealEvent } from './types.js';

export class AnyListClient {
  // The underlying anylist package instance — untyped because the package
  // doesn't ship TypeScript definitions
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any;
  private connected = false;

  constructor(
    private readonly email: string,
    private readonly password: string
  ) {}

  // --- Connection lifecycle ---

  async connect(): Promise<void> {
    logger.info('Connecting to AnyList');
    this.client = new AnyList({ email: this.email, password: this.password });
    await this.client.login();
    await this.client.getLists();
    this.connected = true;
    logger.info('AnyList connection established');
  }

  // Registers a callback that fires whenever any list changes on AnyList.
  // The callback receives the full updated array of lists.
  onListsUpdate(callback: (lists: AnyListList[]) => void): void {
    this.assertConnected();
    this.client.on('lists-update', (rawLists: unknown[]) => {
      const normalized = rawLists.map(normalizeList);
      callback(normalized);
    });
  }

  // Must be called before the process exits to cleanly close the WebSocket.
  disconnect(): void {
    if (this.client && this.connected) {
      this.client.teardown();
      this.connected = false;
      logger.info('AnyList disconnected');
    }
  }

  // --- Reading data ---

  getLists(): AnyListList[] {
    this.assertConnected();
    const raw: unknown[] = this.client.lists ?? [];
    return raw.map(normalizeList);
  }

  getListByName(name: string): AnyListList | null {
    this.assertConnected();
    const raw = this.client.getListByName(name);
    if (!raw) return null;
    return normalizeList(raw);
  }

  async getMealEvents(): Promise<AnyListMealEvent[]> {
    this.assertConnected();
    const rawEvents = await this.client.getMealPlanningCalendarEvents();
    const events: unknown[] = rawEvents ?? [];
    return events.map(normalizeMealEvent);
  }

  // --- Writing data ---

  async addItem(
    listName: string,
    name: string,
    quantity: string = ''
  ): Promise<AnyListItem> {
    this.assertConnected();

    const list = this.client.getListByName(listName);
    if (!list) {
      throw new Error(`AnyList list not found: "${listName}"`);
    }

    const label = quantity ? `${quantity} ${name}` : name;
    const newItem = this.client.createItem({ name: label });
    await list.addItem(newItem);

    logger.debug('Added item to AnyList', { list: listName, label });
    return normalizeItem(newItem);
  }

  async updateItemChecked(
    listName: string,
    itemId: string,
    checked: boolean
  ): Promise<void> {
    this.assertConnected();

    const rawItem = this.findRawItem(listName, itemId);
    rawItem.checked = checked;
    await rawItem.save();

    logger.debug('Updated item checked state in AnyList', { itemId, checked });
  }

  async updateItemName(
    listName: string,
    itemId: string,
    name: string
  ): Promise<void> {
    this.assertConnected();

    const rawItem = this.findRawItem(listName, itemId);
    rawItem.name = name;
    await rawItem.save();

    logger.debug('Updated item name in AnyList', { itemId, name });
  }

  async removeItem(listName: string, itemId: string): Promise<void> {
    this.assertConnected();

    const list = this.client.getListByName(listName);
    if (!list) {
      throw new Error(`AnyList list not found: "${listName}"`);
    }

    const rawItem = this.findRawItem(listName, itemId);
    await list.removeItem(rawItem);

    logger.debug('Removed item from AnyList', { itemId });
  }

  async addMealEvent(title: string, date: Date): Promise<AnyListMealEvent> {
    this.assertConnected();

    const event = this.client.createEvent({ title, date });
    await event.save();

    logger.debug('Added meal event to AnyList', { title, date });
    return normalizeMealEvent(event);
  }

  async removeMealEvent(eventId: string): Promise<void> {
    this.assertConnected();

    // The package requires us to find the raw event object and delete it
    const events = await this.client.getMealPlanningCalendarEvents();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const event = events?.find((e: any) => e.identifier === eventId);
    if (!event) {
      logger.warn('Meal event not found for removal — may have already been deleted', { eventId });
      return;
    }
    await event.delete();

    logger.debug('Removed meal event from AnyList', { eventId });
  }

  // --- Internals ---

  private assertConnected(): void {
    if (!this.connected) {
      throw new Error('AnyListClient is not connected. Call connect() first.');
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private findRawItem(listName: string, itemId: string): any {
    const list = this.client.getListByName(listName);
    if (!list) {
      throw new Error(`AnyList list not found: "${listName}"`);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const item = list.items?.find((i: any) => i.identifier === itemId);
    if (!item) {
      throw new Error(`AnyList item not found: "${itemId}" in list "${listName}"`);
    }
    return item;
  }
}

// --- Normalization helpers ---
// Convert the raw untyped objects from the anylist package into our clean types.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeItem(raw: any): AnyListItem {
  return {
    identifier: raw.identifier ?? '',
    name: raw.name ?? '',
    quantity: raw.quantity ?? '',
    checked: raw.checked === true,
    note: raw.note ?? undefined,
    categoryMatchId: raw.categoryMatchId ?? undefined,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeList(raw: any): AnyListList {
  const items: unknown[] = raw.items ?? [];
  return {
    identifier: raw.identifier ?? '',
    name: raw.name ?? '',
    items: items.map(normalizeItem),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeMealEvent(raw: any): AnyListMealEvent {
  // AnyList meal events can store the meal name in different places depending on
  // how the event was created:
  //   - raw.title: set when the user types a freeform meal name
  //   - raw.recipe?.name: set when the event is linked to a recipe from the recipe box
  //   - raw.details: occasionally used as a fallback label
  const title = raw.title || raw.recipe?.name || raw.details || '';

  return {
    identifier: raw.identifier ?? '',
    title,
    date: raw.date instanceof Date ? raw.date : new Date(raw.date),
  };
}
