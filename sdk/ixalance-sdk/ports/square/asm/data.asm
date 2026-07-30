; data.asm — the demo's data files, linked into the image (the TBL demos did the
; same: Astral's exe blocks are megabytes of embedded data). Paths resolve via
; nasm -I pointing at square_w32/source/demo.

bits 32

section .data

global squarepak_data, squarepak_len
squarepak_data:  incbin "SQUARE.PAK"
squarepak_len:   dd $ - squarepak_data

global peoplelzw_data, peoplelzw_len
peoplelzw_data:  incbin "PEOPLE.LZW"
peoplelzw_len:   dd $ - peoplelzw_data

global zeboulzw_data, zeboulzw_len
zeboulzw_data:   incbin "ZEBOU.LZW"
zeboulzw_len:    dd $ - zeboulzw_data

; The original performs all precalculation before starting its player. Keeping
; the XM in the guest image lets ixa_main hand it to ixa_music_start() at that
; same boundary; a script-level music opcode would start it too early.
global squademo_data, squademo_len
squademo_data:   incbin "SQUADEMO.XM"
squademo_len:    dd $ - squademo_data
