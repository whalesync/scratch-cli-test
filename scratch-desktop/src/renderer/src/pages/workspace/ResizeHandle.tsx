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
    let rafId: number | null = null;
    let pendingDelta = 0;

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current) return;

      pendingDelta += e.clientX - lastXRef.current;
      lastXRef.current = e.clientX;

      if (rafId === null) {
        rafId = requestAnimationFrame(() => {
          rafId = null;
          const delta = pendingDelta;
          pendingDelta = 0;
          onResize(delta);
        });
      }
    };

    const handleMouseUp = () => {
      if (isDraggingRef.current) {
        isDraggingRef.current = false;
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
          rafId = null;
          if (pendingDelta !== 0) {
            onResize(pendingDelta);
            pendingDelta = 0;
          }
        }
        onResizeEnd();
      }
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
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
