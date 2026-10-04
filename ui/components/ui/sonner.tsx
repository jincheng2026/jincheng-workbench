'use client';

import { Toaster as Sonner, type ToasterProps } from 'sonner';

// 右上角的提示条。工作台只有浅色界面，所以固定用浅色。
const Toaster = ({ ...props }: ToasterProps) => {
   return (
      <Sonner
         theme="light"
         className="toaster group"
         toastOptions={{
            classNames: {
               toast: 'group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg',
               description: 'group-[.toast]:text-muted-foreground',
               actionButton: 'group-[.toast]:bg-primary group-[.toast]:text-primary-foreground font-medium',
               cancelButton: 'group-[.toast]:bg-muted group-[.toast]:text-muted-foreground font-medium',
            },
         }}
         {...props}
      />
   );
};

export { Toaster };
