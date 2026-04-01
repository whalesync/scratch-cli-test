import { Box } from '@mantine/core';
import { useCallback, useEffect, useRef, useState } from 'react';

interface ResizeHandleProps {
  onResizeStart: () => void;
  onResize: (deltaX: number) => void;
  onResizeEnd: () => void;
}

export function ResizeHandle({ onResizeStart, onResize, onResizeEnd }: ResizeHandleProps) {
  const isDraggingRef = useRef(false);
  const lastXRef = useRef(0);
  const [isHovered, setIsHovered] = useState(false);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isDraggingRef.current = true;
      lastXRef.current = e.clientX;
      onResizeStart();
    },
    [onResizeStart],
  );

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current) return;

      const deltaX = e.clientX - lastXRef.current;
      lastXRef.current = e.clientX;
      onResize(deltaX);
    };

    const handleMouseUp = () => {
      if (isDraggingRef.current) {
        isDraggingRef.current = false;
        onResizeEnd();
      }
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [onResize, onResizeEnd]);

  return (
    <Box
      onMouseDown={handleMouseDown}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      style={{
        width: 6,
        cursor: 'col-resize',
        backgroundColor: isHovered ? 'var(--mantine-color-gray-3)' : 'transparent',
        transition: 'background-color 0.15s ease',
        flexShrink: 0,
      }}
    />
  );
}
