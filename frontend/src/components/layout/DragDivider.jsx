import { useCallback, useRef, useEffect } from 'react';

const DragDivider = ({ direction = 'vertical', onDrag, onDragEnd }) => {
  const dragging = useRef(false);
  const startPos = useRef(0);

  const handleMouseDown = useCallback((e) => {
    e.preventDefault();
    dragging.current = true;
    startPos.current = direction === 'vertical' ? e.clientX : e.clientY;
    document.body.style.cursor = direction === 'vertical' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
  }, [direction]);

  const handleDoubleClick = useCallback(() => {
    onDragEnd?.('reset');
  }, [onDragEnd]);

  useEffect(() => {
    const handleMouseMove = (e) => {
      if (!dragging.current) return;
      const currentPos = direction === 'vertical' ? e.clientX : e.clientY;
      const delta = currentPos - startPos.current;
      startPos.current = currentPos;
      onDrag?.(delta);
    };

    const handleMouseUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      onDragEnd?.();
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [direction, onDrag, onDragEnd]);

  return (
    <div
      className={`drag-divider drag-divider--${direction}`}
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClick}
    />
  );
};

export default DragDivider;
