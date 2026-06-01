import { type DataSourceObjectResponse, type PageObjectResponse } from '@notionhq/client';

/**
 * @notionhq/client@5.x covers the 2025-09-03 / 2026-03-11 property types
 * including `unique_id`. The legacy 3.1.3-era shim for `place` and `button`
 * is kept (still not in the SDK union) but reduced to those two only.
 */

export type NewNotionProperties = ({ type: 'place' } | { type: 'button' }) & NotionPropertyFields;
export type NotionPropertyFields = {
  id: string;
  name: string;
};
export type SupportedNotionProperties = DataSourceObjectResponse['properties'][string];
export type NotionProperty = SupportedNotionProperties | NewNotionProperties;

export type SupportedPageResponseTypes = PageObjectResponse['properties'][string];
export type NewPageResponseTypes =
  | {
      type: 'place';
      place: {
        lat: number;
        lon: number;
        name: string;
        address: string;
        aws_place_id: string | null;
        google_place_id: string | null;
      } | null;
    }
  | { type: 'unique_id'; unique_id: { prefix: string | null; number: number } }
  | { type: 'button' };

export type PageObjectResponsePropertyTypes = SupportedPageResponseTypes | NewPageResponseTypes;
