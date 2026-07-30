; Register bridge for Square's original radial-blur routine.
;
; _RADIALBLUR retains its Watcom register convention:
;   parm [edi][eax][ebx][esi][ecx][edx]
; This is production-specific assembly; the iXalance entry and host-call
; veneers come from ixalance-sdk/src/crt0.asm.

bits 32

global radialblur_call
extern _RADIALBLUR

section .text

; void radialblur_call(dest, ix, iy, float *f, int *xtab, int *ytab)
radialblur_call:
        push    ebp
        push    ebx
        push    esi
        push    edi
        mov     edi, [esp+20]
        mov     eax, [esp+24]
        mov     ebx, [esp+28]
        mov     esi, [esp+32]
        mov     ecx, [esp+36]
        mov     edx, [esp+40]
        call    _RADIALBLUR
        pop     edi
        pop     esi
        pop     ebx
        pop     ebp
        ret
