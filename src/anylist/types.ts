// Our own normalized types for AnyList data.
// The 'anylist' npm package doesn't ship TypeScript types, so we define the
// shapes we care about here. These mirror the real AnyList objects but only
// include the fields we actually use.

export interface AnyListItem {
  identifier: string;   // AnyList's internal ID
  name: string;         // item label, e.g. "Milk"
  quantity: string;     // e.g. "1 gallon", "2 lbs" — or empty string
  checked: boolean;     // true = completed/crossed off
  note?: string;
  categoryMatchId?: string;
}

export interface AnyListList {
  identifier: string;
  name: string;
  items: AnyListItem[];
}

export interface AnyListMealEvent {
  identifier: string;
  title: string;
  date: Date;
}
