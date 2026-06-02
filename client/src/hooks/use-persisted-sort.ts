import { useLocalStorage } from '@mantine/hooks';
import { useMemo } from 'react';

export type SortDirection = 'asc' | 'desc';

export interface SortConfig<T> {
  field: keyof T;
  direction: SortDirection;
}

export function usePersistedSort<T>(
  items: T[] | undefined | null,
  key: string,
  defaultSort: SortConfig<T>,
  getters?: Partial<Record<keyof T, (item: T) => unknown>>,
) {
  const [sort, setSort] = useLocalStorage<SortConfig<T>>({
    key: key,
    defaultValue: defaultSort,
  });

  const sortedItems = useMemo(() => {
    if (!items) return [];
    return [...items].sort((a, b) => {
      const getterForSortField = getters?.[sort.field];
      const aValue = getterForSortField ? getterForSortField(a) : a[sort.field];
      const bValue = getterForSortField ? getterForSortField(b) : b[sort.field];

      if (aValue == null && bValue == null) return 0;
      if (aValue == null) return 1;
      if (bValue == null) return -1;

      if (typeof aValue === 'string' && typeof bValue === 'string') {
        return sort.direction === 'asc' ? aValue.localeCompare(bValue) : bValue.localeCompare(aValue);
      }

      if (aValue === bValue) return 0;
      const comparison = aValue > bValue ? 1 : -1;
      return sort.direction === 'asc' ? comparison : -comparison;
    });
  }, [items, sort, getters]);

  const handleSort = (field: keyof T) => {
    if (sort.field === field) {
      setSort({ field, direction: sort.direction === 'asc' ? 'desc' : 'asc' });
    } else {
      setSort({ field, direction: 'asc' });
    }
  };

  return { sortedItems, sort, setSort, handleSort };
}
