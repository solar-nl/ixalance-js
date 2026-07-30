/* ixa.ld — the guest link script.
 *
 * The image is linked flat at a nominal base; sdk/tools/elf2d32.mjs rebases
 * every retained R_386_32 fixup to image-relative, and the runtime's
 * relocate() then adds wherever the host's bump allocator actually placed the
 * part. So this address is a placeholder, not a load address — but it must be
 * non-zero, or a null pointer and a valid low address become indistinguishable.
 *
 * .bss deliberately stays out of the file. The D32 header's memrequired covers
 * it and loadExe's fresh allocation is already zero-filled, so shipping zeroes
 * inside the container would only make it bigger.
 */
ENTRY(_start)
SECTIONS
{
    . = 0x00400000;
    .text : { *(.text*) }
    .data : { *(.data*) *(.rodata*) }
    .bss  : { *(.bss*) *(COMMON) }
    /DISCARD/ : { *(.comment) *(.note*) *(.eh_frame*) }
}
