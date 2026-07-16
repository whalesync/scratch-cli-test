import { Group, Input, Text, Textarea, TextareaProps } from '@mantine/core';
import { forwardRef, useCallback, useImperativeHandle, useRef, useState } from 'react';

import mStyles from './EnhancedTextArea.module.css';

export type TextSelection = {
  start: number;
  end: number;
  text: string;
};

export type CursorPosition = {
  position: number;
};

interface EnhancedTextAreaProps extends TextareaProps {
  onSelectionChange?: (selection: { start: number; end: number; text: string }) => void;
  onCursorChange?: (cursor: CursorPosition) => void;
}

export interface TextAreaRef {
  getCursorPosition: () => CursorPosition;
  getSelectedText: () => string;
  setCursorPosition: (start: number, end?: number) => void;
  focus: () => void;
}

export const EnhancedTextArea = forwardRef<TextAreaRef, EnhancedTextAreaProps>(
  ({ onSelectionChange, onCursorChange, ...props }, ref) => {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const [currentSelection, setCurrentSelection] = useState<TextSelection | undefined>(undefined);
    const [currentCursorPosition, setCurrentCursorPosition] = useState<CursorPosition | undefined>(undefined);

    useImperativeHandle(ref, () => ({
      getCursorPosition: () => {
        const textarea = textareaRef.current;
        if (!textarea) return { position: 0 };
        return {
          position: textarea.selectionStart,
        };
      },
      getSelectedText: () => {
        const textarea = textareaRef.current;
        if (!textarea) return '';
        return textarea.value.substring(textarea.selectionStart, textarea.selectionEnd);
      },
      setCursorPosition: (start: number, end?: number) => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        textarea.setSelectionRange(start, end ?? start);
        textarea.focus();
      },
      focus: () => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        textarea.focus();
        // Position cursor at the end of the text
        const length = textarea.value.length;
        textarea.setSelectionRange(length, length);
      },
    }));

    const handleSelectionChange = useCallback(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;

      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const text = textarea.value.substring(start, end);

      setCurrentSelection({ start, end, text });
      setCurrentCursorPosition({ position: start });
      onSelectionChange?.({ start, end, text });
      onCursorChange?.({ position: start });
    }, [textareaRef, onSelectionChange, onCursorChange]);

    const {
      label,
      description,
      error,
      withAsterisk,
      inputWrapperOrder,
      className,
      style,
      flex,
      w,
      h,
      m,
      my,
      mx,
      mt,
      mb,
      ml,
      mr,
      p,
      py,
      px,
      pt,
      pb,
      pl,
      pr,
      classNames,
      ...inputProps
    } = props;

    const customLabel = label ? (
      <Group gap="xs" wrap="nowrap">
        <Text span fw="500">
          {label}
        </Text>
        {currentSelection && currentSelection?.text.length > 0 ? (
          <Text fz="xs" c="dimmed">
            {currentSelection.text.length.toLocaleString()} chars selected
          </Text>
        ) : null}
        {currentCursorPosition && (
          <Text fz="xs" c="dimmed">
            Cursor: {currentCursorPosition.position}
          </Text>
        )}
      </Group>
    ) : null;

    const renderHighlights = (val: string | number | readonly string[] | undefined) => {
      const text = String(val ?? '');
      const regex = /<!-- POTENTIAL DATA LOSS: .*? -->/g;
      const parts = [];
      let lastIndex = 0;
      let match;

      while ((match = regex.exec(text)) !== null) {
        if (match.index > lastIndex) {
          parts.push(text.substring(lastIndex, match.index));
        }
        parts.push(
          <span key={match.index} className={mStyles.highlight}>
            {match[0]}
          </span>,
        );
        lastIndex = regex.lastIndex;
      }

      if (lastIndex < text.length) {
        parts.push(text.substring(lastIndex));
      }

      if (text.endsWith('\n')) {
        parts.push(<br key="last-br" />);
      }

      if (parts.length === 0) return text;

      return parts;
    };

    return (
      <Input.Wrapper
        label={customLabel}
        description={description}
        error={error}
        withAsterisk={withAsterisk}
        inputWrapperOrder={inputWrapperOrder}
        className={className}
        style={style}
        flex={flex}
        w={w}
        h={h}
        m={m}
        my={my}
        mx={mx}
        mt={mt}
        mb={mb}
        ml={ml}
        mr={mr}
        p={p}
        py={py}
        px={px}
        pt={pt}
        pb={pb}
        pl={pl}
        pr={pr}
      >
        <div className={mStyles.container}>
          <div className={mStyles.backdrop} aria-hidden="true">
            {renderHighlights(props.value)}
          </div>
          <Textarea
            {...inputProps}
            label={null}
            description={null}
            error={null}
            ref={textareaRef}
            onSelect={handleSelectionChange}
            onMouseUp={handleSelectionChange}
            onKeyUp={handleSelectionChange}
            onClick={handleSelectionChange}
            classNames={{
              ...(typeof classNames === 'object' ? classNames : {}),
              input: `${mStyles.input} ${typeof classNames === 'object' ? classNames?.input : ''}`,
            }}
          />
        </div>
      </Input.Wrapper>
    );
  },
);

EnhancedTextArea.displayName = 'EnhancedTextArea';
