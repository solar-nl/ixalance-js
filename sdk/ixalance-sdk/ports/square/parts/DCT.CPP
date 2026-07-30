#include "stdafx.h"
#include "common.h"


UBYTE zigzag[64][2]=
{
	{0, 0},
	{0, 1}, {1, 0},
	{2, 0}, {1, 1}, {0, 2},
	{0, 3}, {1, 2}, {2, 1}, {3, 0},
	{4, 0}, {3, 1}, {2, 2}, {1, 3}, {0, 4},
	{0, 5}, {1, 4}, {2, 3}, {3, 2}, {4, 1}, {5, 0},
	{6, 0}, {5, 1}, {4, 2}, {3, 3}, {2, 4}, {1, 5}, {0, 6},
	{0, 7}, {1, 6}, {2, 5}, {3, 4}, {4, 3}, {5, 2}, {6, 1}, {7, 0},
	{7, 1}, {6, 2}, {5, 3}, {4, 4}, {3, 5}, {2, 6}, {1, 7},
	{2, 7}, {3, 6}, {4, 5}, {5, 4}, {6, 3}, {7, 2},
	{7, 3}, {6, 4}, {5, 5}, {4, 6}, {3, 7},
	{4, 7}, {5, 6}, {6, 5}, {7, 4},
	{7, 5}, {6, 6}, {5, 7},
	{6, 7}, {7, 6},
	{7, 7}
};


typedef signed int INT32;
typedef signed int DCTELEM;
typedef DCTELEM DCTBLOCK[8][8];
#define DCTSIZE 8

#define RIGHT_SHIFT(x,y) ((x)>>(y))

#define LG2_DCT_SCALE 16

#define ONE	((INT32) 1)

#define DCT_SCALE (ONE << LG2_DCT_SCALE)

#define LG2_OVERSCALE 2
#define OVERSCALE  (ONE << LG2_OVERSCALE)
#define OVERSHIFT(x)  ((x) <<= LG2_OVERSCALE)

/* Scale a fractional constant by DCT_SCALE */
#define FIX(x)	((INT32) ((x) * DCT_SCALE + 0.5))

/* Scale a fractional constant by DCT_SCALE/OVERSCALE */
/* Such a constant can be multiplied with an overscaled input */
/* to produce something that's scaled by DCT_SCALE */
#define FIXO(x)  ((INT32) ((x) * DCT_SCALE / OVERSCALE + 0.5))

/* Descale and correctly round a value that's scaled by DCT_SCALE */
#define UNFIX(x)   RIGHT_SHIFT((x) + (ONE << (LG2_DCT_SCALE-1)), LG2_DCT_SCALE)

/* Same with an additional division by 2, ie, correctly rounded UNFIX(x/2) */
#define UNFIXH(x)  RIGHT_SHIFT((x) + (ONE << LG2_DCT_SCALE), LG2_DCT_SCALE+1)

/* Take a value scaled by DCT_SCALE and round to integer scaled by OVERSCALE */
#define UNFIXO(x)  RIGHT_SHIFT((x) + (ONE << (LG2_DCT_SCALE-1-LG2_OVERSCALE)),\
				   LG2_DCT_SCALE-LG2_OVERSCALE)

/* Here are the constants we need */
/* SIN_i_j is sine of i*pi/j, scaled by DCT_SCALE */
/* COS_i_j is cosine of i*pi/j, scaled by DCT_SCALE */

#define SIN_1_4 FIX(0.707106781)
#define COS_1_4 SIN_1_4

#define SIN_1_8 FIX(0.382683432)
#define COS_1_8 FIX(0.923879533)
#define SIN_3_8 COS_1_8
#define COS_3_8 SIN_1_8

#define SIN_1_16 FIX(0.195090322)
#define COS_1_16 FIX(0.980785280)
#define SIN_7_16 COS_1_16
#define COS_7_16 SIN_1_16

#define SIN_3_16 FIX(0.555570233)
#define COS_3_16 FIX(0.831469612)
#define SIN_5_16 COS_3_16
#define COS_5_16 SIN_3_16

/* OSIN_i_j is sine of i*pi/j, scaled by DCT_SCALE/OVERSCALE */
/* OCOS_i_j is cosine of i*pi/j, scaled by DCT_SCALE/OVERSCALE */

#define OSIN_1_4 FIXO(0.707106781)
#define OCOS_1_4 OSIN_1_4

#define OSIN_1_8 FIXO(0.382683432)
#define OCOS_1_8 FIXO(0.923879533)
#define OSIN_3_8 OCOS_1_8
#define OCOS_3_8 OSIN_1_8

#define OSIN_1_16 FIXO(0.195090322)
#define OCOS_1_16 FIXO(0.980785280)
#define OSIN_7_16 OCOS_1_16
#define OCOS_7_16 OSIN_1_16

#define OSIN_3_16 FIXO(0.555570233)
#define OCOS_3_16 FIXO(0.831469612)
#define OSIN_5_16 OCOS_3_16
#define OCOS_5_16 OSIN_3_16


void j_rev_dct (DCTBLOCK data)
{
  int pass, rowctr;
  register DCTELEM *inptr, *outptr;
  DCTBLOCK workspace;

  /* Each iteration of the inner loop performs one 8-point 1-D IDCT.
   * It reads from a *row* of the input matrix and stores into a *column*
   * of the output matrix.  In the first pass, we read from the data[] array
   * and store into the local workspace[].  In the second pass, we read from
   * the workspace[] array and store into data[], thus performing the
   * equivalent of a columnar IDCT pass with no variable array indexing.
   */

  inptr = &data[0][0];			/* initialize pointers for first pass */
  outptr = &workspace[0][0];
  for (pass = 1; pass >= 0; pass--) {
	for (rowctr = DCTSIZE-1; rowctr >= 0; rowctr--) {
	  /* many tmps have nonoverlapping lifetime -- flashy register colourers
	   * should be able to do this lot very well
	   */
	  INT32 in0, in1, in2, in3, in4, in5, in6, in7;
	  INT32 tmp10, tmp11, tmp12, tmp13;
	  INT32 tmp20, tmp21, tmp22, tmp23;
	  INT32 tmp30, tmp31;
	  INT32 tmp40, tmp41, tmp42, tmp43;
	  INT32 tmp50, tmp51, tmp52, tmp53;
	  //SHIFT_TEMPS

	  in0 = inptr[0];
	  in1 = inptr[1];
	  in2 = inptr[2];
	  in3 = inptr[3];
	  in4 = inptr[4];
	  in5 = inptr[5];
	  in6 = inptr[6];
	  in7 = inptr[7];

	  /* These values are scaled by DCT_SCALE */

	  tmp10 = (in0 + in4) * COS_1_4;
	  tmp11 = (in0 - in4) * COS_1_4;
	  tmp12 = in2 * SIN_1_8 - in6 * COS_1_8;
	  tmp13 = in6 * SIN_1_8 + in2 * COS_1_8;

	  tmp20 = tmp10 + tmp13;
	  tmp21 = tmp11 + tmp12;
	  tmp22 = tmp11 - tmp12;
	  tmp23 = tmp10 - tmp13;

	  /* These values are scaled by OVERSCALE */

	  tmp30 = UNFIXO((in3 + in5) * COS_1_4);
	  tmp31 = UNFIXO((in3 - in5) * COS_1_4);

	  OVERSHIFT(in1);
	  OVERSHIFT(in7);

	  tmp40 = in1 + tmp30;
	  tmp41 = in7 + tmp31;
	  tmp42 = in1 - tmp30;
	  tmp43 = in7 - tmp31;

	  /* And these are scaled by DCT_SCALE */

	  tmp50 = tmp40 * OCOS_1_16 + tmp41 * OSIN_1_16;
	  tmp51 = tmp40 * OSIN_1_16 - tmp41 * OCOS_1_16;
	  tmp52 = tmp42 * OCOS_5_16 + tmp43 * OSIN_5_16;
	  tmp53 = tmp42 * OSIN_5_16 - tmp43 * OCOS_5_16;

	  outptr[        0] = (DCTELEM) UNFIXH(tmp20 + tmp50);
	  outptr[DCTSIZE  ] = (DCTELEM) UNFIXH(tmp21 + tmp53);
	  outptr[DCTSIZE*2] = (DCTELEM) UNFIXH(tmp22 + tmp52);
	  outptr[DCTSIZE*3] = (DCTELEM) UNFIXH(tmp23 + tmp51);
	  outptr[DCTSIZE*4] = (DCTELEM) UNFIXH(tmp23 - tmp51);
	  outptr[DCTSIZE*5] = (DCTELEM) UNFIXH(tmp22 - tmp52);
	  outptr[DCTSIZE*6] = (DCTELEM) UNFIXH(tmp21 - tmp53);
	  outptr[DCTSIZE*7] = (DCTELEM) UNFIXH(tmp20 - tmp50);

	  inptr += DCTSIZE;		/* advance inptr to next row */
	  outptr++;			/* advance outptr to next column */
	}
	/* end of pass; in case it was pass 1, set up for pass 2 */
	inptr = &workspace[0][0];
	outptr = &data[0][0];
  }
}

LFILE *infi;
DCTBLOCK *dct;
DCTBLOCK qual;

void initdct(int q, int n)
{
        int c3,c4;
        dct=(DCTBLOCK*)malloc(sizeof(DCTBLOCK)*n);
	for (c3=0;c3<8;c3++)
	for (c4=0;c4<8;c4++)
	{
		qual[c3][c4]=(c3+c4)*q+3;
	}

}

void killdct()
{
        if (dct) free(dct);
        dct=NULL;
}


void unpack(UBYTE *image, SLONG q,SLONG w, SLONG h, SLONG bits)
{        
        h*=bits;
	SLONG c0,c1,c2,c3,c4,c5,c6;
	SLONG n=(w/8)*(h/8);
        if (dct==NULL) initdct(q,n);
	for (c5=63;c5>=0;c5--)
	{
		c3=zigzag[c5][0];
		c4=zigzag[c5][1];
		if (c3==0 && c4==0)
		{
			for (c1=0;c1<n;c1+=2)
			{
				c2=0;
				readf(infi,&c2,3);
				dct[c1][0][0]=(c2<<20)>>20;
				dct[c1+1][0][0]=(c2<<8)>>20;
			}
		}
		else
		{
			for (c1=0;c1<n;c1++)
			{
				SBYTE d2;
				readf(infi,&d2,1);
				dct[c1][c3][c4]=d2;
			}
		}
	}
	for (c1=1;c1<n;c1++) dct[c1][0][0]+=dct[c1-1][0][0];

	c0=0;
	h/=bits;
	for (c6=0;c6<bits;c6++)
	{
		for (c1=0;c1<h;c1+=8)
		{
			UBYTE *dest=image+c6+w*c1;
			for (c2=0;c2<w;c2+=8)
			{
				for (c3=0;c3<8;c3++)
				for (c4=0;c4<8;c4++)
				{
					dct[c0][c4][c3]*=qual[c4][c3];
				}
				j_rev_dct(dct[c0]);
				for (c3=0;c3<8;c3++,dest+=(w-8))
				for (c4=0;c4<8;c4++)
				{
					c5=dct[c0][c4][c3];
					if (c5<0) c5=0;if (c5>255) c5=255;
					*dest=c5;
					dest++;
				}
				dest-=(w-1)*8;
				c0++;
			}
		}
	}
}


UBYTE *unpackimage(UBYTE *dest, LFILE *infi2)
{

	if (infi2!=NULL) infi=infi2;

	SLONG q,w,h,bits;
	UBYTE *image;
	w=q=h=bits=0;
	readf(infi,&q,1);
	readf(infi,&w,2);
	readf(infi,&h,2);
	readf(infi,&bits,1);
	image=dest;

	unpack(image,q,w,h,bits);

	return(image);
}

void expandvid(unsigned char *src, unsigned char *dest)
{
	int c1,c2;
	src+=12*144+8;
	for (c1=0;c1<120;c1++)
	{
		for (c2=0;c2<160;c2++)
		{
			dest[0]=(src[0])>>1;
			dest[1]=(src[0]+src[1])>>2;
			dest[320]=(src[0]+src[192])>>3;
			dest[321]=(src[0]+src[1]+src[0]+src[192])>>4;
			dest+=2;
			src++;
		}
		dest+=320;
		src+=192-160;
	}
}


void testvideo()
{
	int c1;

	loadraw((unsigned char*)"data\\logo.raw",tex[0]);
	for (c1=0;c1<64000;c1++) tex[0][c1]|=128;
	memcpy(mypal[128],mypal[0],384);

	for (c1=0;c1<384;c1++) mypal[0][c1]=c1/6;

	setpalblack();

	unsigned char *t0=new unsigned char[192*144*2];
	unsigned char *t1=new unsigned char[192*144*2];
	unsigned char *t2=new unsigned char[192*144*2];
	unsigned char *t3;


	setpalblack();
	palpos=1;
	paldest=0;
	palspd=1.f/300;


	int c0=0;
	float t=0;



	do {
		if (curpos>=FADESTART)
		{
			setpalblack();
			palpos=0;
			paldest=1;
			palspd=1/500;
			palupdate=1;
		}
		c0=0;
		t=0;
		LFILE *f=openflzw((unsigned char*)"data\\people.lzw");
		unpackimage((UBYTE*)t2,f);
		dofproc();
		float spd=1;
		int cp=0;
		while (c0<117 && !kbhit() && curpos>8)
		{
			int dt=dofproc();
			t+=dt*(spd+0.2)*0.4;
			spd*=pow(0.989,dt);

			if (cp!=curpos/32)
			{
				cp=curpos/32;
				spd=1;
			}



			int c2=int(t)+1;
			if (c2>c0)
			{
				t3=t1;t1=t2;t2=t3;
				unpackimage((UBYTE*)t2,f);
				c0++;
				c2=c0;
				t=(t-int(t))+c2-1;
			}
			float f1=t-int(t);
			float f2=1-f1;

			float sh=128*(0.69+sin(t*0.2)*0.3);

			unsigned char *dd=t0;
			unsigned char *s1=t1;
			unsigned char *s2=t2;
			unsigned char *l1=(unsigned char*)multab+256*int(sh*f2);
			unsigned char *l2=(unsigned char*)multab+256*int(sh*f1);
			for (c1=0;c1<192*144;c1++) *dd++ = cliptab128[l1[*s1++]+l2[*s2++]];

			expandvid((unsigned char*)t0,(unsigned char*)screenbuf);

			dd=(unsigned char*)screenbuf+6400;
			s1=(unsigned char*)tex[0];
			//for (c1=0;c1<64000;c1++,dd++,s1++) *dd+=(*s1&15)*2;

			float ff=0.5+spd*0.42; if (ff>0.93) ff=0.93;
			RadialBlur((unsigned char*)screenbuf+6400, 160+50*getwibble(134,t*0.5),100+50*getwibble(72,t*0.5),ff , -0.028);

			for (c1=0;c1<64000;c1++)
			{
				if (tex[0][c1]!=255) screenbuf[c1+6400]=tex[0][c1];
							else screenbuf[c1+6400]=cliptab128[screenbuf[c1+6400]];
			}
			swapscreens(screenbuf+6400);


		}
		closef(f);
	} while (!kbhit() && curpos>8);

	killdct();

	delete [] t0;
	delete [] t1;
	delete [] t2;

}