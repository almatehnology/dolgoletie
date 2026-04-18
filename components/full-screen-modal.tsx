'use client';

import { Modal } from '@heroui/react';
import type { ReactNode } from 'react';

interface FullScreenModalProps {
  isOpen: boolean;
  onOpenChange: (v: boolean) => void;
  children: ReactNode;
  className?: string;
}

/**
 * Модалка на весь экран с отступом 20 px со всех сторон.
 * Оборачивает правильный порядок вложенности HeroUI v3 Modal:
 * Backdrop → Container → Dialog (иначе Container рендерится вне портала).
 */
export function FullScreenModal({ isOpen, onOpenChange, children, className }: FullScreenModalProps) {
  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange}>
      <Modal.Backdrop>
        <Modal.Container size="full" className="!p-5">
          <Modal.Dialog
            className={[
              'flex h-full max-h-full w-full max-w-none flex-col overflow-hidden rounded-xl bg-overlay shadow-2xl',
              className ?? '',
            ].join(' ')}
          >
            {children}
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
