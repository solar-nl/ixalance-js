; asm1.asm — NASM ports of asm1.cpp inline-asm routines, translated 1:1 from
; the MSVC __asm bodies (which are themselves the ASM1_dos.ASM originals).
;
; CALLEE-SAVED REGISTERS. MSVC saved ebx/esi/edi/ebp in the prologue of any
; function whose inline asm clobbered them, so the original bodies could load
; arguments straight into ebx. A standalone port must do that itself, and must
; do it BEFORE touching them: `mov ebx,[esp+12]` followed by pushad saves the
; argument, and popad then "restores" that instead of the caller's ebx. So every
; routine here pushes first and reads its arguments at [esp+36] and up.
; Ported so far: noisefade (asm1.cpp:138-183), unclippedline (asm1.cpp:1764-1902).
;
; Both routines index 64K LUTs by loading the table base into a 32-bit register
; and steering only its low 16 bits (bh/bl, dh/dl) — correct only because
; fadeptr and multab are 64K-aligned (UTILS.CPP:133 masks texram to 0xffff0000).

bits 32

extern fadeptr, noisetab, screenbuf, reciptab, multab, linecol, cliptab128

section .text

global noisefade                ; void noisefade(void *destsrc, u8 *yshades, int seed)
noisefade:
        pushad
        mov     eax, [esp+36]
        mov     edx, [esp+40]
        mov     ebx, [esp+44]
        mov     esi, eax
        mov     ebp, ebx
        mov     edi, edx
        mov     ebx, [fadeptr]
        push    dword 200
.yloop:
        mov     ch, [edi]
        mov     cl, 80
        inc     edi
.xloop:
        and     ebp, 4096-1             ; NOISETABSIZE-1
        mov     bh, [noisetab+ebp]
        add     bh, ch
        mov     bl, [esi+2]
        mov     al, [ebx]
        mov     bh, [noisetab+ebp+1]
        add     bh, ch
        mov     bl, [esi+3]
        mov     ah, [ebx]
        shl     eax, 16
        mov     bh, [noisetab+ebp+2]
        add     bh, ch
        mov     bl, [esi]
        mov     al, [ebx]
        mov     bh, [noisetab+ebp+3]
        add     bh, ch
        mov     bl, [esi+1]
        mov     ah, [ebx]
        add     ebp, 4
        mov     [esi], eax
        add     esi, 4
        dec     cl
        jnz     .xloop
        dec     byte [esp]
        jnz     .yloop
        pop     eax
        popad
        ret

global unclippedline            ; void unclippedline(int x1,int y1,int x2,int y2)
unclippedline:
        pushad
        mov     eax, [esp+36]
        mov     edx, [esp+40]
        mov     ebx, [esp+44]
        mov     ecx, [esp+48]
        sub     ebx, eax
        sub     ecx, edx
        jge     .down
        add     eax, ebx
        add     edx, ecx
        neg     ebx
        neg     ecx
.down:
        test    ebx, ebx
        jz      .zero
        jg      .posa
        neg     ebx
        cmp     ebx, ecx
        jge     .leftwards
        neg     ebx
        jmp     .downwards
.zero:
        test    ecx, ecx
        jz      .doneit
.posa:
        cmp     ebx, ecx
        jge     .rightwards
.downwards:
        shl     eax, 16
        lea     esi, [edx*4+edx]
        shl     esi, 6
        add     esi, [screenbuf]
        mov     ebp, [reciptab+4096+ecx*4]
        imul    ebp, ebx
        or      ecx, ecx
        jle     .doneit
        xor     ebx, ebx
        mov     edx, [multab]
        mov     dh, [linecol]
.loop1:
        mov     dl, ah
        mov     edi, eax
        shr     edi, 16
        add     edi, esi
        not     dl
        mov     bl, [edx]
        add     bl, [edi]
        mov     bl, [cliptab128+ebx]
        mov     [edi], bl
        mov     dl, ah
        mov     bl, [edx]
        add     bl, [edi+1]
        mov     bl, [cliptab128+ebx]
        mov     [edi+1], bl
        add     eax, ebp
        add     esi, 320
        dec     ecx
        jnz     .loop1
        jmp     .doneit
.leftwards:
        sub     eax, ebx
        add     edx, ecx
        neg     ecx
.rightwards:
        xchg    ebx, ecx
        xchg    eax, edx
        shl     eax, 16
        mov     esi, edx
        add     esi, [screenbuf]
        mov     ebp, [reciptab+4096+ecx*4]
        imul    ebp, ebx
        or      ecx, ecx
        jle     .doneit
        xor     ebx, ebx
        mov     edx, [multab]
        mov     dh, [linecol]
.loop2:
        mov     dl, ah
        mov     edi, eax
        shr     edi, 16
        lea     edi, [edi*4+edi]
        shl     edi, 6
        add     edi, esi
        not     dl
        mov     bl, [edx]
        add     bl, [edi]
        mov     bl, [cliptab128+ebx]
        mov     [edi], bl
        mov     dl, ah
        mov     bl, [edx]
        add     bl, [edi+320]
        mov     bl, [cliptab128+ebx]
        mov     [edi+320], bl
        add     eax, ebp
        inc     esi
        dec     ecx
        jnz     .loop2
.doneit:
        popad
        ret

; ---------------------------------------------------------------------------
; Edge-DDA polygon system, 1:1 from asm1.cpp: addedge_ (692-822, naked, with
; its deliberate pop-swap epilogue: end point becomes next start point),
; calccmac (1319-1335), flattri (1338-1385), flatquad (1388-1447),
; flatfill (1450-1520). resetedges lives in stubs.cpp (it is plain C).
extern edgebuf, miny, maxy, cval

section .data
align 4
__x1:   dd 0
__y1:   dd 0
__x2:   dd 0
__y2:   dd 0

section .text

addedge_:                       ; regs: eax,edx -> ebx,ecx
        push    esi
        push    edi
        push    ebp
        push    ebx
        push    ecx
        mov     edi, edgebuf+4
        sub     ebx, eax
        sub     ecx, edx
        je      .forgetit
        jg      .down
        add     eax, ebx
        add     edx, ecx
        neg     ebx
        neg     ecx
        sub     edi, 4
.down:
        cmp     edx, 200
        jge     .forgetit
        lea     ebp, [ecx+edx]
        or      ebp, ebp
        jle     .forgetit
        shl     eax, 16
        mov     esi, [reciptab+4096+ecx*4]
        imul    ebx, esi
        or      edx, edx
        jge     .notop
        add     ecx, edx
        jle     .forgetit
        imul    edx, ebx
        sub     eax, edx
        xor     edx, edx
.notop:
        sub     ebp, 200
        jle     .nobottom
        sub     ecx, ebp
        jle     .forgetit
        xor     ebp, ebp
.nobottom:
        add     ebp, 200
        cmp     ebp, [maxy]
        jle     .sk1
        mov     [maxy], ebp
.sk1:
        cmp     edx, [miny]
        jge     .sk2
        mov     [miny], edx
.sk2:
        xor     ebp, ebp
        mov     esi, 320*65536
        lea     edi, [edi+edx*8]
        or      ebx, ebx
        jle     .left
.right:
        or      eax, eax
        jle     .roffl
.rloop1:
        cmp     eax, esi
        jge     .roffr
        mov     [edi], eax
        add     edi, 8
        add     eax, ebx
.rjumpback:
        dec     ecx
        jnz     .rloop1
        jmp     .forgetit
.roffl:
        mov     dword [edi], ebp
        add     edi, 8
        add     eax, ebx
        jg      .rjumpback
        dec     ecx
        jnz     .roffl
        jmp     .forgetit
.roffr:
        mov     dword [edi], esi
        add     edi, 8
        dec     ecx
        jnz     .roffr
        jmp     .forgetit
.left:
        cmp     eax, esi
        jge     .loffr
.lloop1:
        or      eax, eax
        jle     .loffl
        mov     [edi], eax
        add     edi, 8
        add     eax, ebx
.ljumpback:
        dec     ecx
        jnz     .lloop1
        jmp     .forgetit
.loffr:
        mov     dword [edi], esi
        add     edi, 8
        add     eax, ebx
        cmp     eax, esi
        jl      .ljumpback
        dec     ecx
        jnz     .loffr
        jmp     .forgetit
.loffl:
        mov     dword [edi], ebp
        add     edi, 8
        dec     ecx
        jnz     .loffl
.forgetit:
        pop     edx             ; end point becomes next start point
        pop     eax
        pop     ebp
        pop     edi
        pop     esi
        ret

%macro CALCCMAC 0
        mov     eax, [esi+8+0]
        mov     ebx, [esi+16+4]
        sub     eax, [esi+0]
        sub     ebx, [esi+8+4]
        mov     [__x1], eax
        mov     [__y2], ebx
        imul    ebx
        mov     ebx, [esi+8+4]
        mov     edx, [esi+16+0]
        sub     ebx, [esi+4]
        sub     edx, [esi+8+0]
        mov     [__y1], ebx
        mov     [__x2], edx
        imul    ebx, edx
        sub     eax, ebx
        mov     [cval], eax
%endmacro

global flattri                  ; int flattri(void *dest, void *pts, int col)
flattri:
        push    ebx                     ; callee-saved: GCC holds live values here
        push    esi
        push    edi
        push    ebp
        mov     eax, [esp+20]
        mov     edx, [esp+24]
        mov     ebx, [esp+28]
        push    eax
        push    ebx
        mov     esi, edx
        mov     dword [miny], 200
        mov     dword [maxy], 0
        CALCCMAC
        jle     .pforgetit
        mov     eax, [esi]
        mov     edx, [esi+4]
        mov     ebx, [esi+8]
        mov     ecx, [esi+12]
        call    addedge_
        mov     ebx, [esi+16]
        mov     ecx, [esi+20]
        call    addedge_
        mov     ebx, [esi+0]
        mov     ecx, [esi+4]
        call    addedge_
.pforgetit:
        pop     edx             ; col
        pop     eax             ; dest
        mov     ecx, [cval]
        cmp     ecx, 0
        jle     .skipfill
        push    edx
        push    eax
        call    flatfill
        add     esp, 8
        jmp     .out
.skipfill:
        mov     eax, ecx
.out:
        pop     ebp
        pop     edi
        pop     esi
        pop     ebx
        ret

global flatquad                 ; int flatquad(void *dest, void *pts, int col)
flatquad:
        push    ebx                     ; callee-saved: GCC holds live values here
        push    esi
        push    edi
        push    ebp
        mov     eax, [esp+20]
        mov     edx, [esp+24]
        mov     ebx, [esp+28]
        push    eax
        push    ebx
        mov     esi, edx
        CALCCMAC
        jle     .pforgetit
        mov     dword [miny], 200
        mov     dword [maxy], 0
        mov     eax, [esi]
        mov     edx, [esi+4]
        mov     ebx, [esi+8]
        mov     ecx, [esi+12]
        call    addedge_
        mov     ebx, [esi+16]
        mov     ecx, [esi+20]
        call    addedge_
        mov     ebx, [esi+24]
        mov     ecx, [esi+28]
        call    addedge_
        mov     ebx, [esi+0]
        mov     ecx, [esi+4]
        call    addedge_
.pforgetit:
        pop     edx
        pop     eax
        mov     ecx, [cval]
        cmp     ecx, 0
        jle     .skipfill
        push    edx
        push    eax
        call    flatfill
        add     esp, 8
        jmp     .out
.skipfill:
        mov     eax, ecx
.out:
        pop     ebp
        pop     edi
        pop     esi
        pop     ebx
        ret

global flatfill                 ; int flatfill(void *dest, int col)
flatfill:
        mov     eax, [esp+4]
        mov     edx, [esp+8]
        or      eax, eax
        jz      .goaway
        pushad
        mov     dh, dl
        mov     ebx, eax
        mov     eax, edx
        shl     edx, 16
        or      eax, edx
        mov     esi, [miny]
        mov     edx, [maxy]
        sub     edx, esi
        jle     .forgetit2
        lea     edi, [esi*4+esi]
        shl     edi, 6
        add     ebx, edi
        lea     esi, [edgebuf+esi*8]
.lineloop:
        mov     edi, [esi]
        mov     ecx, [esi+4]
        shr     edi, 16
        shr     ecx, 16
        sub     ecx, edi
        jle     .nextline
        lea     edi, [ebx+edi]
        mov     ebp, [edi+3]
        test    edi, 1
        jz      .notodd
        dec     ecx
        mov     [edi], al
        jz      .nextline
        inc     edi
.notodd:
        test    edi, 2
        jz      .notodd2
        dec     ecx
        mov     [edi], al
        jz      .nextline
        inc     edi
        dec     ecx
        mov     [edi], al
        jz      .nextline
        inc     edi
.notodd2:
        mov     ebp, [edi+60]
        mov     ebp, ecx
        shr     ecx, 2
        rep stosd
        mov     ecx, ebp
        and     ecx, 3
        rep stosb
.nextline:
        add     esi, 8
        add     ebx, 320
        dec     edx
        jnz     .lineloop
        popad
.goaway:
        mov     eax, [cval]
        ret
.forgetit2:
        popad
        mov     eax, -1
        ret

; ---------------------------------------------------------------------------
; Gouraud span filler (asm1.cpp:1174-1310) and its calcincr gradient setup
; (asm1.cpp:833-895). calcincr consumes the __x1/__y1/__x2/__y2 edge deltas and
; cval that calccmac stored during the preceding flattri, so gouraudfill is only
; ever valid immediately after one. The colour walks as 16.16 fixed point split
; across ebp (fraction) and bl (integer), stepped by `add ebp,edx / adc bl,bh`.

section .data
align 4
yinc_c: dd 0
xinc_c: dd 0

section .text

%macro CALCINCR 4               ; %1=ecx offset  %2=yinc  %3=xinc  %4=adjust
        mov     eax, [ecx+4+%1]
        sub     eax, [ecx+%1]
        imul    eax, [__x2]
        mov     edx, [ecx+8+%1]
        sub     edx, [ecx+4+%1]
        imul    edx, [__x1]
        sub     eax, edx
        neg     eax
        cmp     eax, 32767
        jge     %%toobig1
        cmp     eax, -32768
        jle     %%toobig1
        cdq
        shld    edx, eax, 16
        shl     eax, 16
        idiv    dword [cval]
        jmp     %%toobig1a
%%toobig1:
        cdq
        shld    edx, eax, 12
        shl     eax, 12
        idiv    dword [cval]
        shl     eax, 4
        jmp     %%toobig1a
%%toobig2:
        cdq
        shld    edx, eax, 12
        shl     eax, 12
        idiv    dword [cval]
        shl     eax, 4
        jmp     %%toobig2a
%%toobig1a:
        mov     [%2], eax
        mov     eax, [ecx+8+%1]
        sub     eax, [ecx+4+%1]
        imul    eax, [__y1]
        mov     edx, [ecx+4+%1]
        sub     edx, [ecx+0+%1]
        imul    edx, [__y2]
        sub     eax, edx
        neg     eax
        cmp     eax, 32767
        jge     %%toobig2
        cmp     eax, -32768
        jle     %%toobig2
        cdq
        shld    edx, eax, 16
        shl     eax, 16
        idiv    dword [cval]
%%toobig2a:
        mov     [%3], eax
        imul    eax, [ebp]
        mov     ebp, [ebp+4]
        imul    ebp, [%2]
        add     ebp, eax
        mov     eax, [ecx+%1]
        neg     ebp
        shl     eax, 16
        add     ebp, eax
        mov     eax, [%2]
        imul    eax, esi
%ifnidn %4,0
        add     ebp, [%4]
%endif
        add     ebp, 32768
        add     ebp, eax
%endmacro

global gouraudfill              ; void gouraudfill(void *dest, void *col, void *pts)
gouraudfill:
        pushad
        mov     eax, [esp+36]
        mov     edx, [esp+40]
        mov     ebx, [esp+44]
        mov     ebp, ebx                ; pts (first x,y only)
        mov     ebx, eax                ; dest
        mov     ecx, edx                ; col
        mov     esi, [miny]
        mov     edx, [maxy]
        sub     edx, esi
        jle     .forgetit
        lea     edi, [esi*4+esi]
        shl     edi, 6
        add     ebx, edi
        push    edx
        CALCINCR 0, yinc_c, xinc_c, xinc_c
        pop     edx
        lea     esi, [edgebuf+esi*8]
.lineloop:
        push    ebp
        push    ebx
        push    edx
        mov     edi, [esi]
        mov     ecx, [esi+4]
        shr     edi, 16
        shr     ecx, 16
        sub     ecx, edi
        jle     .nextline
        mov     edx, [xinc_c]
        mov     eax, edx
        imul    eax, edi
        add     ebp, eax
        lea     edi, [ebx+edi]
        shld    ebx, ebp, 16            ; bl = integer colour (clobbers dest, restored)
        rol     edx, 16
        shl     ebp, 16
        mov     bh, dl
        mov     eax, [edi+3]            ; fill the cache...
        test    edi, 1
        jz      .notodd
        dec     ecx
        mov     [edi], bl
        jz      .nextline
        add     ebp, edx
        inc     edi
        adc     bl, bh
.notodd:
        test    edi, 2
        jz      .notodd2
        dec     ecx
        mov     [edi], bl
        jz      .nextline
        add     ebp, edx
        inc     edi
        adc     bl, bh
        dec     ecx
        mov     [edi], bl
        jz      .nextline
        add     ebp, edx
        inc     edi
        adc     bl, bh
.notodd2:
        push    ecx
        mov     eax, [edi+60]
        shr     ecx, 2
        jz      .endbit
.pixloop:
        mov     al, bl
        add     ebp, edx
        adc     bl, bh
        mov     ah, bl
        add     ebp, edx
        adc     bl, bh
        rol     eax, 16
        mov     al, bl
        add     ebp, edx
        adc     bl, bh
        mov     ah, bl
        add     ebp, edx
        adc     bl, bh
        rol     eax, 16
        mov     [edi], eax
        add     edi, 4
        dec     ecx
        jnz     .pixloop
.endbit:
        pop     ecx
        and     ecx, 3
        jz      .nextline
        dec     ecx
        mov     [edi], bl
        jz      .nextline
        add     ebp, edx
        adc     bl, bh
        dec     ecx
        mov     [edi+1], bl
        jz      .nextline
        add     ebp, edx
        adc     bl, bh
        mov     [edi+2], bl
.nextline:
        pop     edx
        pop     ebx
        pop     ebp
        add     ebp, [yinc_c]
        add     esi, 8
        add     ebx, 320
        dec     edx
        jnz     .lineloop
.forgetit:
        popad
        ret

; ghosto (lzwasm.cpp:610-658): dest = cliptab128[dest/4 + src], four at a time.
global ghosto                   ; void ghosto(void *dest, void *src)
ghosto:
        pushad
        mov     eax, [esp+36]
        mov     edx, [esp+40]
        mov     edi, eax
        mov     esi, edx
        mov     ecx, 64000/4
        xor     ebx, ebx
        xor     edx, edx
.again:
        mov     eax, [edi]
        shr     eax, 2
        and     eax, 0x1f1f1f1f
        add     eax, [esi]
        mov     bl, al
        mov     dl, ah
        mov     al, [cliptab128+ebx]
        mov     ah, [cliptab128+edx]
        rol     eax, 16
        mov     bl, al
        mov     dl, ah
        mov     al, [cliptab128+ebx]
        mov     ah, [cliptab128+edx]
        rol     eax, 16
        mov     [edi], eax
        add     edi, 4
        add     esi, 4
        dec     ecx
        jnz     .again
        popad
        ret

; composelight (asm1.cpp:537-581): dest = tab[dest | ((src/4 + 0x30)<<8)].
; `tab` is steered through bl/bh, so it must be a 64K-aligned table.
global composelight             ; void composelight(void *dest, void *src, void *tab)
composelight:
        pushad
        mov     eax, [esp+36]
        mov     edx, [esp+40]
        mov     ebx, [esp+44]
        mov     edi, eax
        mov     esi, edx
        mov     ecx, 64000/4
.again:
        mov     edx, [esi]
        shr     edx, 2
        mov     eax, [edi]
        and     edx, 0x1f1f1f1f
        mov     bl, al
        add     edx, 0x30303030
        mov     bh, dl
        mov     al, [ebx]
        mov     bl, ah
        mov     bh, dh
        mov     ah, [ebx]
        rol     eax, 16
        rol     edx, 16
        mov     bl, al
        mov     bh, dl
        mov     al, [ebx]
        mov     bl, ah
        mov     bh, dh
        mov     ah, [ebx]
        rol     eax, 16
        add     esi, 4
        mov     [edi], eax
        add     edi, 4
        dec     ecx
        jnz     .again
        popad
        ret

; ---------------------------------------------------------------------------
; composesil (asm1.cpp:489-535): like composelight but /4 masked to 6 bits with
; a 0x10 bias — the silhouette variant.
global composesil               ; void composesil(void *dest, void *src, void *tab)
composesil:
        pushad
        mov     eax, [esp+36]
        mov     edx, [esp+40]
        mov     ebx, [esp+44]
        mov     edi, eax
        mov     esi, edx
        mov     ecx, 64000/4
.again:
        mov     edx, [esi]
        shr     edx, 2
        mov     eax, [edi]
        and     edx, 0x3f3f3f3f
        mov     bl, al
        add     edx, 0x10101010
        mov     bh, dl
        mov     al, [ebx]
        mov     bl, ah
        mov     bh, dh
        mov     ah, [ebx]
        rol     eax, 16
        rol     edx, 16
        mov     bl, al
        mov     bh, dl
        mov     al, [ebx]
        mov     bl, ah
        mov     bh, dh
        mov     ah, [ebx]
        rol     eax, 16
        add     esi, 4
        mov     [edi], eax
        add     edi, 4
        dec     ecx
        jnz     .again
        popad
        ret

; ---------------------------------------------------------------------------
; Pin-grid texture mapper — pnimap.h, instantiated as drawpinmapns
; (asm1.cpp:2050-2056: WIDTH 40, HEIGHT 25, adjust 0). Each pin cell maps an
; 8x8 screen block by bilinear-stepping u/v through a forward-difference chain:
; edx carries u plus the low byte of v, bl the high byte of v, ebp:cl the
; per-pixel increments, and ival*/yval* the per-row delta-deltas.
extern pin

section .data
align 4
pintexptr:  dd 0
ival1:      dd 0
yval1:      dd 0
ival2:      db 0
yval2:      db 0
            align 4

section .text

%macro PINMAP 3                 ; %1=WIDTH  %2=HEIGHT  %3=adjust
        pushad
        mov     eax, [esp+36]           ; srctex
        mov     edx, [esp+40]           ; dest
        mov     esi, pin
        mov     edi, edx
        mov     [pintexptr], eax
        mov     ch, %2
%%pinyloop:
        mov     cl, %1
%%pinxloop:
        push    esi
        push    ecx
        mov     eax, [esi+12+0]
        sub     eax, [esi+0]
        mov     edx, [esi+12*(%1+2)+0]
        sub     edx, [esi+12*(%1+1)+0]
        sub     edx, eax
        sar     eax, 3
        sar     edx, 6+%3
        mov     ebp, eax
        sar     eax, 31
        mov     cl, al
        mov     [ival1], edx
        sar     edx, 31
        mov     [ival2], dl
        mov     eax, [esi+12*(%1+1)+0]
        sub     eax, [esi+0]
        sar     eax, 3+%3
        mov     [yval1], eax
        sar     eax, 31
        mov     [yval2], al
        mov     eax, [esi+12+4]
        sub     eax, [esi+4]
        mov     edx, [esi+12*(%1+2)+4]
        sub     edx, [esi+12*(%1+1)+4]
        sub     edx, eax
        sar     eax, 3
        sar     edx, 6+%3
        add     cl, ah
        shl     eax, 24
        add     ebp, eax
        adc     cl, 0
        add     [ival2], dh
        shl     edx, 24
        add     [ival1], edx
        adc     byte [ival2], 0
        mov     eax, [esi+12*(%1+1)+4]
        sub     eax, [esi+4]
        sar     eax, 3+%3
        add     [yval2], ah
        shl     eax, 24
        add     [yval1], eax
        adc     byte [yval2], 0
        mov     ebx, [pintexptr]
        mov     dl, [esi+4]
        shl     edx, 24
        add     edx, 0x800000
        mov     eax, [esi+0]
        and     eax, 65535
        add     edx, eax
        mov     bl, [esi+4+1]
        mov     ch, 8<<%3
%%again:
        push    edx
        push    ebx
        mov     bh, dh
        add     edx, ebp
        mov     al, [ebx]
        mov     bh, dh
        adc     bl, cl
        add     edx, ebp
        mov     ah, [ebx]
        mov     bh, dh
        adc     bl, cl
        rol     eax, 16
        add     edx, ebp
        mov     al, [ebx]
        adc     bl, cl
        mov     bh, dh
        add     edx, ebp
        mov     ah, [ebx]
        adc     bl, cl
        rol     eax, 16
        mov     [edi], eax
        mov     bh, dh
        add     edx, ebp
        mov     al, [ebx]
        mov     bh, dh
        adc     bl, cl
        add     edx, ebp
        mov     ah, [ebx]
        mov     bh, dh
        adc     bl, cl
        rol     eax, 16
        add     edx, ebp
        mov     al, [ebx]
        adc     bl, cl
        mov     bh, dh
        add     edx, ebp
        mov     ah, [ebx]
        adc     bl, cl
        rol     eax, 16
        mov     [edi+4], eax
        pop     ebx
        pop     edx
        mov     eax, [yval1]
        mov     bh, [yval2]
        add     edx, eax
        adc     bl, bh
        mov     eax, [ival1]
        mov     bh, [ival2]
        add     ebp, eax
        adc     cl, bh
        add     edi, %1*8
        dec     ch
        jnz     %%again
        pop     ecx
        pop     esi
        add     esi, 12
        sub     edi, %1*8*(8<<%3)-8
        dec     cl
        jnz     %%pinxloop
        add     esi, 12
        add     edi, %1*8*(8<<%3)-%1*8
        dec     ch
        jnz     %%pinyloop
        popad
%endmacro

global drawpinmapns             ; void drawpinmapns(void *srctex, void *dest)
drawpinmapns:
        PINMAP 40, 25, 0
        ret

; ---------------------------------------------------------------------------
; The compose family (asm1.cpp:445-673). All four walk 64000 bytes four at a
; time, steering a 64K-aligned LUT through bl (dest pixel) and bh (src pixel,
; optionally scaled and biased). Only the src transform differs.
extern ghostptr, zmaptab1, zmaptab2, zmaptab3

%macro COMPOSE 3                ; %1 = shr count, %2 = mask, %3 = bias (0 = none)
        pushad
        mov     eax, [esp+36]
        mov     edx, [esp+40]
        mov     ebx, [esp+44]
        mov     edi, eax
        mov     esi, edx
        mov     ecx, 64000/4
%%again:
        mov     edx, [esi]
%if %1
        shr     edx, %1
%endif
        mov     eax, [edi]
%if %3
        and     edx, %2
        mov     bl, al
        add     edx, %3
%else
        mov     bl, al
%endif
        mov     bh, dl
        mov     al, [ebx]
        mov     bl, ah
        mov     bh, dh
        mov     ah, [ebx]
        rol     eax, 16
        rol     edx, 16
        mov     bl, al
        mov     bh, dl
        mov     al, [ebx]
        mov     bl, ah
        mov     bh, dh
        mov     ah, [ebx]
        rol     eax, 16
        add     esi, 4
        mov     [edi], eax
        add     edi, 4
        dec     ecx
        jnz     %%again
        popad
        ret
%endmacro

global compose                  ; asm1.cpp:445 — straight two-source LUT
compose:
        COMPOSE 0, 0, 0

global composelightdark         ; asm1.cpp:629 — src/2, 6 bits, +0x10
composelightdark:
        COMPOSE 1, 0x3f3f3f3f, 0x10101010

; ghostcopy (asm1.cpp:2076-2106): a 256x256 alpha table indexed by
; (src,dest) pairs, two pixels at a time through ebx and ecx.
global ghostcopy                ; void ghostcopy(void *dest, void *src)
ghostcopy:
        pushad
        mov     eax, [esp+36]
        mov     edx, [esp+40]
        mov     edi, eax
        mov     esi, edx
        mov     ebx, [ghostptr]
        mov     ebp, 64000/4
        mov     ecx, ebx
.again:
        mov     bl, [esi+2]
        mov     bh, [edi+2]
        mov     cl, [esi+2+1]
        mov     ch, [edi+2+1]
        mov     al, [ebx]
        mov     ah, [ecx]
        shl     eax, 16
        mov     bl, [esi+0]
        mov     bh, [edi+0]
        mov     cl, [esi+0+1]
        mov     ch, [edi+0+1]
        mov     al, [ebx]
        mov     ah, [ecx]
        add     esi, 4
        mov     [edi], eax
        add     edi, 4
        dec     ebp
        jnz     .again
        popad
        ret

; blendproc (asm1.cpp:1725-1762): depth-of-field composite. The z byte selects
; three weights from zmaptab1/2/3, each of which indexes multab against one of
; three progressively blurred copies of the screen.
%macro BLENDMAC 2               ; %1 = dest byte reg, %2 = offset
        mov     al, [esi+%2]
        mov     bl, [zmaptab1+eax]
        mov     bh, [ebp+%2]
        mov     %1, [ebx]
        mov     bl, [zmaptab2+eax]
        mov     bh, [ebp+%2+64000]
        add     %1, [ebx]
        mov     bl, [zmaptab3+eax]
        mov     bh, [ebp+%2+128000]
        add     %1, [ebx]
%endmacro

global blendproc                ; void blendproc(void *dest, void *zbuf, void *src)
blendproc:
        pushad
        mov     eax, [esp+36]
        mov     edx, [esp+40]
        mov     ebx, [esp+44]
        mov     edi, eax
        mov     esi, edx
        mov     ebp, ebx
        mov     ebx, [multab]
        xor     eax, eax
        xor     edx, edx
        add     esi, 4*320
        add     edi, 4*320
        add     ebp, 4*320
        mov     ecx, (200-8)*80
.pixloop:
        BLENDMAC dl, 2
        BLENDMAC dh, 3
        shl     edx, 16
        BLENDMAC dl, 0
        BLENDMAC dh, 1
        add     esi, 4
        add     ebp, 4
        mov     [edi], edx
        add     edi, 4
        dec     ecx
        jnz     .pixloop
        popad
        ret

; blurproc (asm1.cpp:1641-1707): a 21-tap round-kernel blur kept as a running
; sum in bx — each step adds the incoming right column and subtracts the
; outgoing left one — divided by 21 through the assembler-built divide21 table.
extern divide21

%macro PW_RA 0                  ; add the incoming right column
        add     bl, [esi-640+2]
        adc     bh, 0
        add     bl, [esi-320+3]
        adc     bh, 0
        add     bl, [esi+3]
        adc     bh, 0
        add     bl, [esi+320+3]
        adc     bh, 0
        add     bl, [esi+640+2]
        adc     bh, 0
%endmacro
%macro PW_LS 0                  ; subtract the outgoing left column
        sub     bl, [esi-640-1]
        sbb     bh, 0
        sub     bl, [esi-320-2]
        sbb     bh, 0
        sub     bl, [esi-2]
        sbb     bh, 0
        sub     bl, [esi+320-2]
        sbb     bh, 0
        sub     bl, [esi+640-1]
        sbb     bh, 0
%endmacro
%macro BPIX 4                   ; %1..%4: 1 = emit that column update, 0 = skip
        mov     al, [divide21+ebx]
%if %2
        PW_RA
%endif
%if %1
        PW_LS
%endif
        inc     esi
        mov     ah, [divide21+ebx]
%if %4
        PW_RA
%endif
%if %3
        PW_LS
%endif
        inc     esi
        mov     [edi], ax
        inc     edi
        inc     edi
%endmacro

global blurproc                 ; void blurproc(void *dest, void *src)
blurproc:
        pushad
        mov     eax, [esp+36]
        mov     edx, [esp+40]
        mov     esi, edx
        mov     edi, eax
        add     esi, 320*2
        add     edi, 320*2
        mov     ecx, 195*256
.lineloop:
        xor     ebx, ebx
        xor     eax, eax
        mov     bl, [esi-640]
        add     bl, [esi-640+1]
        adc     bh, cl
        add     bl, [esi-320+0]
        adc     bh, cl
        add     bl, [esi-320+1]
        adc     bh, cl
        add     bl, [esi-320+2]
        adc     bh, cl
        add     bl, [esi+0]
        adc     bh, cl
        add     bl, [esi+1]
        adc     bh, cl
        add     bl, [esi+2]
        adc     bh, cl
        add     bl, [esi+320+0]
        adc     bh, cl
        add     bl, [esi+320+1]
        adc     bh, cl
        add     bl, [esi+320+2]
        adc     bh, cl
        add     bl, [esi+640+0]
        adc     bh, cl
        add     bl, [esi+640+1]
        adc     bh, cl
        BPIX 0, 1, 1, 1                 ; first two pixels have no left column
        mov     cl, (320-6)/2
.xloop:
        BPIX 1, 1, 1, 1
        dec     cl
        jnz     .xloop
        BPIX 1, 0, 1, 0                 ; last two have no right column
        inc     edi
        inc     esi
        inc     edi
        inc     esi
        dec     ch
        jnz     .lineloop
        popad
        ret

; The remaining pnimap.h instantiations (asm1.cpp:2058-2072).
global drawpinmaptex            ; WIDTH 32, HEIGHT 32, adjust 0
drawpinmaptex:
        PINMAP 32, 32, 0
        ret

global drawpinmap48             ; WIDTH 40, HEIGHT 30, adjust 1
drawpinmap48:
        PINMAP 40, 30, 1
        ret

; ---------------------------------------------------------------------------
; quantum (asm1.cpp:35-137): error-diffusion sparkle. Pass 1 halves every pixel
; (>>1 & 0x7f7f7f7f). Pass 2 compares each pixel against a noise threshold and,
; where it wins, splays a fixed 4x4 kernel (EBXVAL/EDXVAL packed as four bytes)
; into the four following scanlines, then clips through cliptab128. Every 8th
; scanline it reseeds the noise index from rand(), which is why the body has to
; be able to call back into C.
extern noisetab2, alexrand

%define EBXVAL 0x01020201
%define EDXVAL 0x02040402

section .data
align 4
_qtemp: dd 0

section .text

%macro ADDMAC 1                 ; %1 = byte offset; carry set means "below noise"
        jbe     %%nope
        add     [edi+%1+  0], ebx
        add     [edi+%1+320], edx
        add     [edi+%1+640], edx
        add     [edi+%1+960], ebx
%%nope:
%endmacro

global quantum                  ; void quantum(void *dest, void *src, int seed)
quantum:
        pushad
        mov     eax, [esp+36]
        mov     edx, [esp+40]
        mov     ebx, [esp+44]
        mov     edi, eax
        mov     esi, edx
        mov     ebp, ebx
        mov     ecx, 320*200/8
.floop:
        mov     eax, [edi]
        mov     ebx, [edi+4]
        shr     eax, 1                  ; XXX
        shr     ebx, 1
        and     eax, 0x7f7f7f7f         ; YYY
        and     ebx, 0x7f7f7f7f
        mov     [edi], eax
        mov     [edi+4], ebx
        add     edi, 8
        dec     ecx
        jnz     .floop
        sub     edi, 320*200
        mov     ebx, EBXVAL
        mov     edx, EDXVAL
        mov     ch, 200-4
.yloop:
        mov     cl, 320/4-1
.xloop:
        mov     eax, [esi]
        and     ebp, 4096-1             ; NOISETABSIZE-1
        cmp     al, [noisetab2+ebp]
        ADDMAC 0
        cmp     ah, [noisetab2+ebp+1]
        ADDMAC 1
        shr     eax, 16
        cmp     al, [noisetab2+ebp+2]
        ADDMAC 2
        cmp     ah, [noisetab2+ebp+3]
        ADDMAC 3
        mov     eax, [edi]              ; clipping pass
        xor     ebx, ebx
        mov     bl, al
        mov     al, [cliptab128+ebx]
        mov     bl, ah
        mov     ah, [cliptab128+ebx]
        rol     eax, 16
        mov     bl, al
        mov     al, [cliptab128+ebx]
        mov     bl, ah
        mov     ah, [cliptab128+ebx]
        rol     eax, 16
        mov     ebx, EBXVAL
        mov     [edi], eax
        add     ebp, 4
        add     edi, 4
        add     esi, 4
        dec     cl
        jnz     .xloop
        mov     dword [edi], 0
        add     edi, 4
        add     esi, 4
        dec     ch
        jz      .donet
        test    ch, 7
        jnz     .yloop
        pushad
        call    alexrand
        mov     [_qtemp], eax
        popad
        mov     eax, [_qtemp]
        mov     ebp, eax
        jmp     .yloop
.donet:
        popad
        ret

; ---------------------------------------------------------------------------
; scalespr (asm1.cpp:249-443): additive scaled sprite blitter used for the lens
; flares. Builds a 256-entry intensity ramp in spritetab from `col`, clips the
; destination rectangle, precomputes one x-step delta per output column in
; edgetab, then walks scanlines adding through cliptab128.
section .data
align 4
sspr_dest:  dd 0
sspr_bw:    dd 0
sspr_bh:    dd 0
sspr_bp:    dd 0
sspr_col:   dd 0
sspr_xinc:  dd 0
sspr_yinc:  dd 0
sspr_xs:    dd 0
sspr_ys:    dd 0
sspr_xc:    dd 0
sspr_yc:    dd 0
edgetab:    times 512*2 dd 0
spritetab:  times 256*2 db 0
            align 4

section .text

global scalespr
scalespr:
        pushad
        mov     eax, [esp+52]           ; dest
        mov     [sspr_dest], eax
        mov     eax, [esp+56]           ; bmpwid
        mov     [sspr_bw], eax
        mov     eax, [esp+60]           ; bmphgt
        mov     [sspr_bh], eax
        mov     eax, [esp+64]           ; bmpptr
        mov     [sspr_bp], eax
        mov     eax, [esp+68]           ; col
        mov     [sspr_col], eax
        mov     eax, [esp+36]           ; x1
        mov     edx, [esp+40]           ; y1
        mov     ebx, [esp+44]           ; x2
        mov     ecx, [esp+48]           ; y2
        push    eax
        mov     edi, spritetab
        mov     esi, 256
        xor     eax, eax
.sprloop:
        mov     [edi], ah
        inc     edi
        add     eax, [sspr_col]
        cmp     eax, 128*256
        jl      .skkk
        mov     eax, 0x7fff
.skkk:
        dec     esi
        jnz     .sprloop
        pop     eax
        xchg    edx, ebx                ; eax,edx = x1,x2 ; ebx,ecx = y1,y2
        cmp     eax, 320
        jge     .forgetit
        or      edx, edx
        jle     .forgetit
        cmp     ebx, 200
        jge     .forgetit
        or      ecx, ecx
        jle     .forgetit
        sub     edx, eax
        jle     .forgetit
        sub     ecx, ebx
        jle     .forgetit
        push    edx
        push    eax
        mov     ebp, edx
        xor     edx, edx
        mov     eax, 65536
        imul    eax, [sspr_bw]
        div     ebp
        mov     [sspr_xinc], eax
        xor     edx, edx
        mov     eax, 65536
        imul    eax, [sspr_bh]
        div     ecx
        mov     [sspr_yinc], eax
        pop     eax
        pop     edx
        add     edx, eax
        add     ecx, ebx
        mov     dword [sspr_xs], 0
        mov     dword [sspr_ys], 0
        or      eax, eax
        jge     .nc1
        imul    eax, [sspr_xinc]
        neg     eax
        mov     [sspr_xs], eax
        xor     eax, eax
.nc1:
        cmp     edx, 320
        jle     .nc2
        mov     edx, 320
.nc2:
        or      ebx, ebx
        jge     .nc3
        imul    ebx, [sspr_yinc]
        neg     ebx
        mov     [sspr_ys], ebx
        xor     ebx, ebx
.nc3:
        cmp     ecx, 200
        jle     .nc4
        mov     ecx, 200
.nc4:
        sub     edx, eax
        jle     .forgetit
        sub     ecx, ebx
        jle     .forgetit
        mov     [sspr_xc], edx
        mov     [sspr_yc], ecx
        imul    ebx, 320
        lea     esi, [ebx+eax]
        add     esi, [sspr_dest]
        mov     ecx, [sspr_xc]
        mov     edi, edgetab
        mov     eax, [sspr_xs]
        mov     ebp, [sspr_xinc]
.tabloop:
        mov     edx, eax
        sar     edx, 16
        mov     [edi], edx
        and     eax, 65535
        add     eax, ebp
        add     edi, 4
        dec     ecx
        jnz     .tabloop
        xor     edx, edx
.lineloop:
        mov     edi, edgetab
        mov     ecx, [sspr_xc]
        push    esi
        mov     ebx, [sspr_ys]
        shr     ebx, 16
        imul    ebx, [sspr_bw]
        mov     eax, [sspr_yinc]
        add     [sspr_ys], eax
        add     ebx, [sspr_bp]
.pixloop:
        add     ebx, [edi]
        mov     dl, [ebx]
        mov     dl, [spritetab+edx]
        add     dl, [esi]
        mov     al, [cliptab128+edx]
        dec     ecx
        jz      .justal
        inc     esi
        add     edi, 4
        add     ebx, [edi]
        mov     dl, [ebx]
        mov     dl, [spritetab+edx]
        add     dl, [esi]
        mov     ah, [cliptab128+edx]
        add     edi, 4
        dec     ecx
        mov     [esi-1], ax
        jz      .doneloop
        inc     esi
        jmp     .pixloop
.justal:
        mov     [esi], al
.doneloop:
        pop     esi
        add     esi, 320
        dec     dword [sspr_yc]
        jnz     .lineloop
.forgetit:
        popad
        ret

; xfade (lzwasm.cpp:560-608): weighted cross-fade of two 640x480-sized buffers
; through multab, biased by 0x80 per byte.
global xfade                    ; void xfade(void *dest, void *src, int di, int si)
xfade:
        pushad
        mov     eax, [esp+36]
        mov     edx, [esp+40]
        mov     ebx, [esp+44]
        mov     ecx, [esp+48]
        mov     edi, eax
        mov     esi, edx
        mov     eax, ebx
        mov     ebx, [multab]
        mov     edx, ebx
        mov     bh, cl
        mov     dh, al
        mov     ecx, 640*480/4
.again:
        mov     bl, [esi+2]
        mov     dl, [edi+2]
        mov     al, [ebx]
        add     al, [edx]
        mov     bl, [esi+3]
        mov     dl, [edi+3]
        mov     ah, [ebx]
        add     ah, [edx]
        shl     eax, 16
        mov     bl, [esi]
        mov     dl, [edi]
        mov     al, [ebx]
        add     al, [edx]
        mov     bl, [esi+1]
        mov     dl, [edi+1]
        mov     ah, [ebx]
        add     ah, [edx]
        xor     eax, 0x80808080
        mov     [edi], eax
        add     esi, 4
        add     edi, 4
        dec     ecx
        jnz     .again
        popad
        ret

; ---------------------------------------------------------------------------
; texgoufill (asm1.cpp:949-1170): textured + Gouraud span filler, the most
; intricate routine in the demo. Three calcincr chains (u at pts+12, v at +24,
; colour at +0) drive one carry cascade per pixel:
;
;   esi high half = u fraction      add esi,[ulo]       -> CF
;   ecx           = v frac : u int  adc ecx,[uhi_vlo]   -> CF
;   bh            = v integer       adc bh,[vhi]
;
; so ebx = texptr | v<<8 | u addresses the 64K texture directly, and
; eax = fadeptr | colour<<8 shades the fetched texel in one more lookup.
;
; `ulo` is deliberately a word immediately followed by xinc_u, so that reading
; a dword at ulo yields low16(xinc_u)<<16 — the u fractional step positioned to
; match esi. asm1.cpp gets that from declaration order (a_static short ulo;
; a_static int xinc_u;); here it is explicit.
extern texptr

section .data
align 4
tg_val1:    dd 0
line_u:     dd 0
line_v:     dd 0
line_c:     dd 0
line_edi:   dd 0
uhi_vlo:    dd 0
vhi:        dd 0
yinc_u:     dd 0
yinc_v:     dd 0
ulo:        dw 0                    ; must stay immediately before xinc_u
xinc_u:     dd 0
            dw 0
xinc_v:     dd 0

section .text

global texgoufill               ; void texgoufill(void *dest, void *col, void *pts)
texgoufill:
        pushad
        mov     eax, [esp+36]
        mov     edx, [esp+40]
        mov     ebx, [esp+44]
        mov     [tg_val1], ebx          ; pts (first x,y used only)
        mov     ebx, eax                ; dest
        mov     ecx, edx                ; col
        mov     esi, [miny]
        mov     edx, [maxy]
        sub     edx, esi
        jle     .forgetit
        lea     edi, [esi*4+esi]
        shl     edi, 6
        add     ebx, edi
        sub     ebx, 2
        mov     [line_edi], ebx
        push    edx
        mov     ebp, [tg_val1]
        CALCINCR 12, yinc_u, xinc_u, xinc_u
        mov     [line_u], ebp
        mov     ebp, [tg_val1]
        CALCINCR 24, yinc_v, xinc_v, xinc_v
        mov     [line_v], ebp
        mov     ebp, [tg_val1]
        CALCINCR 0, yinc_c, xinc_c, 0
        mov     [line_c], ebp
        mov     eax, [xinc_u]
        cdq
        sar     eax, 16
        mov     ecx, [xinc_v]
        shl     ecx, 16
        add     eax, ecx
        mov     [uhi_vlo], eax
        mov     eax, [xinc_v]
        adc     edx, 0
        sar     eax, 16
        add     eax, edx
        mov     dword [vhi], eax
        pop     edx
        lea     esi, [edgebuf+esi*8]
.lineloop:
        mov     edi, [esi]
        mov     ecx, [esi+4]
        shr     edi, 16
        shr     ecx, 16
        sub     ecx, edi
        jle     .nextline
        push    esi
        push    edx
        push    ecx                     ; count lives at [esp]
        mov     ebx, [texptr]
        mov     ecx, [xinc_v]
        imul    ecx, edi
        add     ecx, [line_v]
        rol     ecx, 16
        mov     bh, cl                  ; v: ecx high half frac, bh integer
        mov     eax, [xinc_u]
        imul    eax, edi
        add     eax, [line_u]
        rol     eax, 16
        mov     cl, al                  ; u integer into ecx low byte
        xor     al, al
        mov     esi, eax                ; u fraction in esi high half
        mov     eax, [fadeptr]
        mov     edx, [xinc_c]
        imul    edx, edi
        add     edx, [line_c]
        rol     edx, 16
        mov     ah, dl                  ; colour integer into eax high byte
        mov     ebp, [xinc_c]
        shl     ebp, 16
        mov     ch, [xinc_c+2]
        add     edi, [line_edi]
        test    edi, 1
        jnz     .notodd
        mov     bl, cl
        add     edx, ebp
        mov     al, [ebx]
        adc     ah, ch
        add     esi, [ulo]
        adc     ecx, [uhi_vlo]
        mov     dl, [eax]
        adc     bh, [vhi]
        mov     [edi+2], dl
        dec     dword [esp]
        jz      .doneline
        inc     edi
.notodd:
        shr     dword [esp], 1
        jz      .mustdraw1
        adc     esi, 0                  ; remember the odd pixel in esi bit 0
.xloop:
        mov     bl, cl
        add     edx, ebp
        mov     al, [ebx]
        adc     ah, ch
        add     esi, [ulo]
        adc     ecx, [uhi_vlo]
        mov     dl, [eax]
        adc     bh, [vhi]
        mov     bl, cl
        add     edx, ebp
        mov     al, [ebx]
        adc     ah, ch
        add     esi, [ulo]
        adc     ecx, [uhi_vlo]
        mov     dh, [eax]
        adc     bh, [vhi]
        add     edi, 2
        dec     dword [esp]
        mov     [edi], dx
        jnz     .xloop
        test    esi, 1
        jz      .doneline
.mustdraw1:
        mov     bl, cl
        add     edx, ebp
        mov     al, [ebx]
        adc     ah, ch
        mov     dl, [eax]
        mov     [edi+2], dl
.doneline:
        pop     ecx
        pop     edx
        pop     esi
.nextline:
        dec     edx
        jz      .forgetit
        add     esi, 8
        add     dword [line_edi], 320
        mov     eax, [yinc_u]
        mov     ebx, [yinc_v]
        mov     ecx, [yinc_c]
        add     [line_u], eax
        add     [line_v], ebx
        add     [line_c], ecx
        jmp     .lineloop
.forgetit:
        popad
        ret

; ---------------------------------------------------------------------------
; Remaining inner loops used by the restored production sequence.

; blurfade (asm1.cpp:190-234): a five-tap blur with the original carry-aware
; byte accumulator, divided by eight to fade on every pass.
%macro BLURFADE_PIXEL 1
        mov     al, [esi+%1-1]
        add     al, [esi+%1+1]
        add     al, [esi+%1+320]
        adc     ah, bl
        add     al, [esi+%1-320]
        adc     ah, bl
        add     al, [esi+%1]
        adc     ah, bl
        shr     eax, 3
%endmacro

global blurfade
blurfade:
        pushad
        mov     edi, [esp+36]
        mov     esi, [esp+40]
        xor     ebx, ebx
        xor     eax, eax
        mov     ecx, 320*200/4
.again:
        BLURFADE_PIXEL 2
        mov     dl, al
        BLURFADE_PIXEL 3
        mov     dh, al
        shl     edx, 16
        BLURFADE_PIXEL 0
        mov     dl, al
        BLURFADE_PIXEL 1
        mov     dh, al
        mov     [edi], edx
        add     esi, 4
        add     edi, 4
        dec     ecx
        jnz     .again
        popad
        ret

; composedark (asm1.cpp:583-627): the dark half of the BJORK compositor.
global composedark
composedark:
        pushad
        mov     edi, [esp+36]
        mov     esi, [esp+40]
        mov     ebx, [esp+44]
        mov     ecx, 64000/4
.again:
        mov     edx, [esi]
        shr     edx, 2
        mov     eax, [edi]
        and     edx, 0x1f1f1f1f
        neg     edx
        mov     bl, al
        add     edx, 0x30303030
        mov     bh, dl
        mov     al, [ebx]
        mov     bl, ah
        mov     bh, dh
        mov     ah, [ebx]
        rol     eax, 16
        rol     edx, 16
        mov     bl, al
        mov     bh, dl
        mov     al, [ebx]
        mov     bl, ah
        mov     bh, dh
        mov     ah, [ebx]
        rol     eax, 16
        add     esi, 4
        mov     [edi], eax
        add     edi, 4
        dec     ecx
        jnz     .again
        popad
        ret

section .data
align 4
roto_first: db 1
roto_tab:   times 512 db 0
align 4

section .text

; rotocopy/copy320to256 (lzwasm.cpp:469-558). The old lzwasm translation
; references a file-scope mytab that the Win32 source accidentally leaves
; hidden inside crotocopy; initialise the intended 190/256 clamp table here.
global rotocopy
rotocopy:
        pushad
        cmp     byte [roto_first], 0
        je      .ready
        mov     byte [roto_first], 0
        mov     edi, roto_tab
        mov     ecx, 512
        xor     eax, eax
.tabloop:
        cmp     eax, 255*256
        jle     .tabok
        mov     eax, 255*256
.tabok:
        mov     [edi], ah
        inc     edi
        add     eax, 190
        dec     ecx
        jnz     .tabloop
.ready:
        mov     edi, [esp+36]
        mov     esi, [esp+40]
        mov     ebp, [esp+44]
        xor     ebx, ebx
        mov     ecx, 64000/4
.again:
        mov     bl, [esi]
        mov     dl, [ebp]
        add     bl, [esi+1]
        rcr     bl, 1
        shr     dl, 1
        add     bl, dl
        rcr     bl, 1
        mov     al, [roto_tab+ebx]
        mov     bl, [esi+1]
        mov     dl, [ebp+1]
        add     bl, [esi+2]
        rcr     bl, 1
        shr     dl, 1
        add     bl, dl
        rcr     bl, 1
        mov     ah, [roto_tab+ebx]
        rol     eax, 16
        mov     bl, [esi+2]
        mov     dl, [ebp+2]
        add     bl, [esi+3]
        rcr     bl, 1
        shr     dl, 1
        add     bl, dl
        rcr     bl, 1
        mov     al, [roto_tab+ebx]
        mov     bl, [esi+3]
        mov     dl, [ebp+3]
        add     bl, [esi+4]
        rcr     bl, 1
        shr     dl, 1
        add     bl, dl
        rcr     bl, 1
        mov     ah, [roto_tab+ebx]
        rol     eax, 16
        mov     [edi], eax
        add     edi, 4
        add     esi, 4
        add     ebp, 4
        dec     ecx
        jnz     .again
        popad
        ret

global copy320to256
copy320to256:
        pushad
        mov     edi, [esp+36]
        mov     esi, [esp+40]
        mov     ecx, 64000/20
.again:
        mov     eax, [esi]
        mov     ebx, [esi+5]
        mov     edx, [esi+10]
        mov     ebp, [esi+15]
        mov     [edi], eax
        mov     [edi+4], ebx
        mov     [edi+8], edx
        mov     [edi+12], ebp
        add     esi, 20
        add     edi, 16
        dec     ecx
        jnz     .again
        popad
        ret

extern _blurwid

section .data
align 4
hb_texture: dd 0
hb_dest:    dd 0
hb_fadetab: dd 0
hb_fadeinc: dd 0
hb_size:    dd 0

section .text

; hblur (asm1.cpp:1905-2026): rolling horizontal box filter. `al` carries the
; dword count and `ah` the line count exactly as in the MSVC body.
global hblur
hblur:
        pushad
        mov     eax, [esp+52]
        mov     [hb_texture], eax
        mov     eax, [esp+56]
        mov     [hb_dest], eax
        mov     eax, [esp+60]
        mov     [hb_fadetab], eax
        mov     eax, [esp+64]
        mov     [hb_fadeinc], eax
        mov     eax, [esp+68]
        mov     [hb_size], eax
        mov     eax, [esp+36]           ; bmapwid
        mov     edx, [esp+40]           ; blurwid
        mov     ebx, [esp+44]           ; numdwords
        mov     ecx, [esp+48]           ; numlines
        mov     ebp, eax
        mov     al, bl
        mov     ah, cl
        mov     ecx, ebp
        mov     esi, [hb_texture]
        mov     edi, [hb_dest]
        mov     ebp, [hb_fadetab]
        xor     ebx, ebx
.fillloop:
        rol     ebx, 16
        mov     [ebp], bl
        rol     ebx, 16
        add     ebx, [hb_fadeinc]
        cmp     ebx, 256*65536
        jl      .fillok
        mov     ebx, 256*65536-1
.fillok:
        inc     ebp
        dec     dword [hb_size]
        jnz     .fillloop
        mov     ebp, [hb_fadetab]
.lineloop:
        push    ecx
        push    esi
        mov     ecx, edx
        shr     ecx, 1
        sub     esi, ecx
        mov     ecx, edx
        xor     ebx, ebx
.startloop:
        add     bl, [esi]
        inc     esi
        adc     bh, 0
        dec     ecx
        jnz     .startloop
        sub     esi, edx
        push    edi
        push    eax
        mov     cl, al
.pixloop:
        mov     al, [ebx+ebp]
        add     bl, [esi+edx]
        adc     bh, ch
        sub     bl, [esi]
        sbb     bh, ch
        mov     ah, [ebx+ebp]
        add     bl, [esi+edx+1]
        adc     bh, ch
        sub     bl, [esi+1]
        sbb     bh, ch
        rol     eax, 16
        mov     al, [ebx+ebp]
        add     bl, [esi+edx+2]
        adc     bh, ch
        sub     bl, [esi+2]
        sbb     bh, ch
        mov     ah, [ebx+ebp]
        add     bl, [esi+edx+3]
        adc     bh, ch
        sub     bl, [esi+3]
        sbb     bh, ch
        rol     eax, 16
        mov     [edi], eax
        add     edi, 4
        add     esi, 4
        dec     cl
        jnz     .pixloop
        pop     eax
        pop     edi
        pop     esi
        pop     ecx
        add     edi, [_blurwid]
        add     esi, ecx
        dec     ah
        jnz     .lineloop
        popad
        ret

; drawpinmap (lzwasm.cpp:204-464): the shaded 40x25 pin-grid mapper. This is
; the pnimap forward-difference chain plus a second chain for palette shade;
; each 8x8 cell indexes the 64K texture through ebx and fadeptr through ecx.
section .data
align 4
dp_val1:    dd 0
dp_ival1:   dd 0
dp_yval1:   dd 0
dp_iebp:    dd 0
dp_yebp:    dd 0
dp_val2:    db 0
dp_ival2:   db 0
dp_val3:    db 0
dp_ival3:   db 0
dp_yval2:   db 0
dp_yval3:   db 0
dp_scratch: times 32 db 0
align 4

section .text
global drawpinmap
drawpinmap:
        pushad
        mov     eax, [esp+36]
        mov     edx, [esp+40]
        mov     esi, pin
        mov     edi, edx
        mov     [pintexptr], eax
        mov     ch, 25
.pinyloop:
        mov     cl, 40
.pinxloop:
        push    esi
        push    ecx

        ; u: horizontal increment, row delta-delta and vertical increment
        mov     eax, [esi+12+0]
        sub     eax, [esi+0]
        mov     edx, [esi+12*42+0]
        sub     edx, [esi+12*41+0]
        sub     edx, eax
        sar     eax, 3
        sar     edx, 6
        mov     [dp_val1], eax
        sar     eax, 31
        mov     [dp_val2], al
        mov     [dp_ival1], edx
        sar     edx, 31
        mov     [dp_ival2], dl
        mov     eax, [esi+12*41+0]
        sub     eax, [esi+0]
        sar     eax, 3
        mov     [dp_yval1], eax
        sar     eax, 31
        mov     [dp_yval2], al

        ; v is packed into the high half/bytes of the same chains.
        mov     eax, [esi+12+4]
        sub     eax, [esi+4]
        mov     edx, [esi+12*42+4]
        sub     edx, [esi+12*41+4]
        sub     edx, eax
        sar     eax, 3
        sar     edx, 6
        add     [dp_val2], ah
        shl     eax, 24
        add     [dp_val1], eax
        adc     byte [dp_val2], 0
        add     [dp_ival2], dh
        shl     edx, 24
        add     [dp_ival1], edx
        adc     byte [dp_ival2], 0
        mov     eax, [esi+12*41+4]
        sub     eax, [esi+4]
        sar     eax, 3
        add     [dp_yval2], ah
        shl     eax, 24
        add     [dp_yval1], eax
        adc     byte [dp_yval2], 0

        ; shade increment and its row delta-delta.
        mov     eax, [esi+12+8]
        sub     eax, [esi+8]
        mov     edx, [esi+12*42+8]
        sub     edx, [esi+12*41+8]
        sub     edx, eax
        sar     eax, 3
        sar     edx, 6
        mov     [dp_val3], ah
        shl     eax, 24
        mov     ebp, eax
        mov     [dp_ival3], dh
        shl     edx, 24
        mov     [dp_iebp], edx
        mov     eax, [esi+12*41+8]
        sub     eax, [esi+8]
        sar     eax, 3
        mov     [dp_yval3], ah
        shl     eax, 24
        mov     [dp_yebp], eax

        mov     ebx, [pintexptr]
        mov     ecx, [fadeptr]
        mov     dl, [esi+4]
        shl     edx, 24
        add     edx, 0x800000
        mov     eax, [esi+0]
        and     eax, 65535
        add     edx, eax
        mov     bl, [esi+4+1]
        mov     ch, [esi+8+1]
        mov     esi, [esi+8]
        shl     esi, 24
        mov     byte [dp_scratch], 8

.again:
        mov     [dp_scratch+4], bl
        mov     [dp_scratch+8], ch
        mov     [dp_scratch+12], edx
        mov     [dp_scratch+16], esi

        mov     bh, dh
        add     edx, [dp_val1]
        mov     cl, [ebx]
        mov     bh, [dp_val2]
        mov     al, [ecx]
        adc     bl, bh
        add     esi, ebp
        mov     cl, [dp_val3]
        mov     bh, dh
        adc     ch, cl

        mov     ah, [dp_val2]
        add     edx, [dp_val1]
        mov     cl, [ebx]
        adc     bl, ah
        mov     ah, [ecx]
        mov     cl, [dp_val3]
        add     esi, ebp
        adc     ch, cl
        rol     eax, 16

        mov     bh, dh
        mov     al, [dp_val2]
        add     edx, [dp_val1]
        mov     cl, [ebx]
        adc     bl, al
        mov     al, [ecx]
        mov     cl, [dp_val3]
        add     esi, ebp
        adc     ch, cl

        mov     bh, dh
        add     edx, [dp_val1]
        mov     cl, [ebx]
        mov     bh, [dp_val2]
        mov     ah, [ecx]
        adc     bl, bh
        add     esi, ebp
        mov     cl, [dp_val3]
        mov     bh, dh
        adc     ch, cl
        rol     eax, 16
        mov     [edi], eax

        mov     bh, dh
        add     edx, [dp_val1]
        mov     cl, [ebx]
        mov     bh, [dp_val2]
        mov     al, [ecx]
        adc     bl, bh
        add     esi, ebp
        mov     cl, [dp_val3]
        mov     bh, dh
        adc     ch, cl

        mov     ah, [dp_val2]
        add     edx, [dp_val1]
        mov     cl, [ebx]
        adc     bl, ah
        mov     ah, [ecx]
        mov     cl, [dp_val3]
        add     esi, ebp
        adc     ch, cl
        rol     eax, 16

        mov     bh, dh
        mov     al, [dp_val2]
        add     edx, [dp_val1]
        mov     cl, [ebx]
        adc     bl, al
        mov     al, [ecx]
        mov     cl, [dp_val3]
        add     esi, ebp
        adc     ch, cl

        mov     bh, dh
        add     edx, [dp_val1]
        mov     cl, [ebx]
        mov     bh, [dp_val2]
        mov     ah, [ecx]
        adc     bl, bh
        add     esi, ebp
        mov     cl, [dp_val3]
        mov     bh, [dp_scratch]
        adc     ch, cl
        rol     eax, 16
        mov     [edi+4], eax

        mov     bl, [dp_scratch+4]
        mov     ch, [dp_scratch+8]
        mov     edx, [dp_scratch+12]
        mov     esi, [dp_scratch+16]
        mov     eax, [dp_yval1]
        mov     cl, [dp_yval2]
        add     edx, eax
        adc     bl, cl
        mov     eax, [dp_yebp]
        mov     cl, [dp_yval3]
        add     esi, eax
        adc     ch, cl
        mov     eax, [dp_iebp]
        add     ebp, eax
        mov     al, [dp_ival3]
        adc     [dp_val3], al
        add     edi, 320
        mov     eax, [dp_ival1]
        add     [dp_val1], eax
        mov     al, [dp_ival2]
        adc     [dp_val2], al
        dec     bh
        mov     [dp_scratch], bh
        jnz     .again

        pop     ecx
        pop     esi
        add     esi, 12
        sub     edi, 320*8-8
        dec     cl
        jnz     .pinxloop
        add     esi, 12
        add     edi, 320*8-320
        dec     ch
        jnz     .pinyloop
        popad
        ret
