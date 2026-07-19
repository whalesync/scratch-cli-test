import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import { PostgresColumnType } from '@spinner/shared-types';
import { Braces, Brackets, Hash, ToggleLeft, Type } from 'lucide-react';

// Function to get column type icon
export const getColumnTypeIcon = (pgType: PostgresColumnType) => {
  switch (pgType) {
    case PostgresColumnType.TEXT:
      return <StyledLucideIcon Icon={Type} size={14} c="#888" />;
    case PostgresColumnType.NUMERIC:
    case PostgresColumnType.NUMERIC_STRING:
      return <StyledLucideIcon Icon={Hash} size={14} c="#888" />;
    case PostgresColumnType.BOOLEAN:
      return <StyledLucideIcon Icon={ToggleLeft} size={14} c="#888" />;
    case PostgresColumnType.JSONB:
      return <StyledLucideIcon Icon={Braces} size={14} c="#888" />;

    case PostgresColumnType.NUMERIC_ARRAY:
      return <StyledLucideIcon Icon={Brackets} size={14} c="#888" />;
    case PostgresColumnType.TEXT_ARRAY:
      return <StyledLucideIcon Icon={Brackets} size={14} c="#888" />;
    case PostgresColumnType.BOOLEAN_ARRAY:
      return <StyledLucideIcon Icon={Brackets} size={14} c="#888" />;
    default:
      return <StyledLucideIcon Icon={Type} size={14} c="#888" />;
  }
};
