'use client';

// 「在访达中打开选题库」这类按钮：让后台用这台 Mac 的访达或默认程序打开设置里的固定位置。
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { PrimaryButton, SecondaryButton } from '@/components/jc/ui';
import { errorText, openPlace, type Place } from '@/lib/api';

export function PlaceButton({
   place,
   children,
   primary = false,
   size = 'small',
   title,
   tour,
}: {
   place: Place;
   children: ReactNode;
   primary?: boolean;
   size?: 'regular' | 'small';
   title?: string;
   /** 给新手指引找按钮用的记号（data-tour） */
   tour?: string;
}) {
   const [busy, setBusy] = useState(false);
   const run = async () => {
      setBusy(true);
      try {
         toast.success((await openPlace(place)).message);
      } catch (error) {
         toast.error(`没能打开：${errorText(error)}`);
      } finally {
         setBusy(false);
      }
   };
   const Button = primary ? PrimaryButton : SecondaryButton;
   return (
      <Button size={size} busy={busy} onClick={() => void run()} title={title} tour={tour}>
         {children}
      </Button>
   );
}
