; crt0.asm — iXalance guest entry veneer and host-call wrappers.
;
; The host (code.asm's startdemo; lib/machine.js loadExe here) far-calls the
; guest exactly once, with:
;
;   ebx = the guest's CS selector — the segment for every far pointer below
;   esi = a pointer to a POINTER to gfxmodeinfo (one indirection, not two)
;
; and an argument frame already on the stack. Ascending from the entry esp —
; note pushFar stores the 32-bit offset FIRST and the 16-bit selector at the
; LOWER address, so each slot reads {word sel; dword offset}:
;
;   +0   dword  return EIP    (host return address; retf here ends the part)
;   +4   dword  return CS
;   +8   word sel  +10  dword offset   farmalloc
;   +14  word sel  +16  dword offset   fardoint
;   +20  dword  &mustime      {u8 order; u8 row}
;   +24  dword  &herzcount    (tick accumulator; consume by writing 0)
;   +28  word sel  +30  dword offset   slot 0  (farbasic)
;   +34  word sel  +36  dword offset   slot 1  (farbasic)
;   +40  word sel  +42  dword offset   slot 2  (farshowp — presents a frame)
;   +46  word sel  +48  dword offset   slot 3  (farbasic)
;   +52  word sel  +54  dword offset   slot 4  (farbasic)
;
; Only slot 2 flips the buffer; the other four are housekeeping-only. They are
; captured as an array so the layout is visible and an advanced guest can reach
; any slot, but the SDK itself only ever calls slot 2 and slot 0.
;
; This must run before anything else touches the stack: one push and the
; offsets above are gone.

bits 32

global _start
global ixa_host_showp, ixa_host_basic, ixa_host_malloc, ixa_host_doint
global ixa_exit
global ixa_gfxinfo, ixa_herzcount, ixa_mustime, ixa_slot

extern ixa_main

SLOT_SIZE       equ 6                   ; dd offset, dw selector
SLOT_SHOWP      equ 2 * SLOT_SIZE
SLOT_BASIC      equ 0 * SLOT_SIZE

section .text

_start:
        mov     eax, [esi]              ; *esi -> gfxmodeinfo
        mov     [ixa_gfxinfo], eax
        mov     eax, [esp+20]
        mov     [ixa_mustime], eax
        mov     eax, [esp+24]
        mov     [ixa_herzcount], eax

        mov     eax, [esp+10]
        mov     [farmalloc], eax
        mov     [farmalloc+4], bx
        mov     eax, [esp+16]
        mov     [fardoint], eax
        mov     [fardoint+4], bx

        ; the five call slots, in ascending stack order
        mov     eax, [esp+30]
        mov     [ixa_slot + 0*SLOT_SIZE], eax
        mov     eax, [esp+36]
        mov     [ixa_slot + 1*SLOT_SIZE], eax
        mov     eax, [esp+42]
        mov     [ixa_slot + 2*SLOT_SIZE], eax
        mov     eax, [esp+48]
        mov     [ixa_slot + 3*SLOT_SIZE], eax
        mov     eax, [esp+54]
        mov     [ixa_slot + 4*SLOT_SIZE], eax
        mov     [ixa_slot + 0*SLOT_SIZE + 4], bx
        mov     [ixa_slot + 1*SLOT_SIZE + 4], bx
        mov     [ixa_slot + 2*SLOT_SIZE + 4], bx
        mov     [ixa_slot + 3*SLOT_SIZE + 4], bx
        mov     [ixa_slot + 4*SLOT_SIZE + 4], bx

        mov     [saved_esp], esp        ; ixa_exit unwinds to here
        call    ixa_main
        ; fall through: ixa_main returning ends the part like ixa_exit does

; void ixa_exit(void) — end the part now, from any call depth. The saved esp
; still points at the host's return frame, so retf lands on the host return
; address and the container script resumes at the next command.
ixa_exit:
        mov     esp, [saved_esp]
        retf

; cdecl wrappers. The host's trampoline intercept preserves every register
; except the effects each call documents (farmalloc: eax=0, edx=block, cf=0).

; void ixa_host_showp(void) — present the framebuffer + pump host clocks
ixa_host_showp:
        call    far [ixa_slot + SLOT_SHOWP]
        ret

; void ixa_host_basic(void) — pump host clocks only, no present
ixa_host_basic:
        call    far [ixa_slot + SLOT_BASIC]
        ret

; void *ixa_host_malloc(unsigned bytes) — part-memory arena bump
ixa_host_malloc:
        mov     edx, [esp+4]
        call    far [farmalloc]
        mov     eax, edx
        ret

; unsigned ixa_host_doint(unsigned code, const void *ptr, unsigned len)
; The generic fardoint gate: code in eax, an optional buffer in esi/ecx.
;   'TBL1' (0x54424C31) — start the XM at ptr, length len
;   'TBL3' (0x54424C33) — return (row + 1) | (order << 8), 0 if silent
ixa_host_doint:
        push    esi                     ; esi is callee-saved under cdecl
        mov     eax, [esp+8]
        mov     esi, [esp+12]
        mov     ecx, [esp+16]
        call    far [fardoint]
        pop     esi
        ret

section .data
align 4
ixa_slot:       times 5 * SLOT_SIZE db 0
                times 2 db 0            ; pad the 30-byte array back to align 4
farmalloc:      dd 0
                dw 0
fardoint:       dd 0
                dw 0
ixa_gfxinfo:    dd 0
ixa_herzcount:  dd 0
ixa_mustime:    dd 0
saved_esp:      dd 0
