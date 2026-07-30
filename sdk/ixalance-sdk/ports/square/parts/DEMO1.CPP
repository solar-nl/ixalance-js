#include "stdafx.h"
#include "common.h"

unsigned char fontstr[]="?!{}()-:;@+'abcdefghijklmnopqrstuvwxyz0123456789";

unsigned char ycols[200];

PIN pin[41][41];
CAM mycam;
FVector light;

void setpal(void *p)
{
	palpos=paldest=0;
	palupdate=1;
	faderfproc();
}


void calcfmat(float t,float p,float *o)
{
	float a,b,c,d;
	a=sin(t);b=cos(t);
	c=sin(p);d=cos(p);
	*o++=b*d;
	*o++=a;
	*o++=-b*c;
	*o++=-a*d;
	*o++=b;
	*o++=a*c;
	*o++=c;
	*o++=0;
	*o++=d;
}

void calcynoise(unsigned char *o, int base, int blobp, int blobm)
{
	int c1;

	#define NUMYBAR 32
	static int y[NUMYBAR];
	static int dy[NUMYBAR];
	static int c[NUMYBAR];
	static int s[NUMYBAR];
	static int f=1;
	if (f)
	{
		f=0;
		for (c1=0;c1<NUMYBAR;c1++)
		{
			y[c1]=4*((rand()&255)-20);
			dy[c1]=4*((rand()&255)-20);
			c[c1]=(c1&1)?blobp:blobm;
			s[c1]=(rand()&3)+2;
		}
	}
	if (!o)
	{
		for (c1=0;c1<NUMYBAR;c1++)
		{
			if (y[c1]>dy[c1]) y[c1]-=s[c1]; else
			if (y[c1]<dy[c1]) y[c1]+=s[c1];
			if (abs(dy[c1]-y[c1])<5) dy[c1]=4*((rand()&255)-20);
		}
		return;
	}
	unsigned char *oo=o;
	for (c1=0;c1<200;c1++)
	{
		*o++=base+(rand()&7);
	}
	for (c1=0;c1<NUMYBAR;c1++)
	{
		if (y[c1]>=0 && y[c1]<4*200) oo[y[c1]/4]+=c[c1];
	}

}

void ynoisefproc()
{
	calcynoise(NULL);
}

void line(int x1,int y1,int x2, int y2)
{
	int cc1=(x1<1)|((y1<1)<<1)|((x1>319)<<2)|((y1>199)<<3);
	int cc2=(x2<1)|((y2<1)<<1)|((x2>319)<<2)|((y2>199)<<3);
	if (cc1&cc2) return;
	if (cc1=(cc1^cc2))
	{
		// clip
		int c;
		//int ox1=x1;int oy1=y1;
		if (cc1&1)
		{
			// left clip
			c=y1+(y2-y1)*(float(1-x1)/float(x2-x1));
			if (x1<1) {x1=1;y1=c;} else if (x2<1) {x2=1;y2=c;};
		}
		if (cc1&2)
		{
			// top clip
			c=x1+(x2-x1)*(float(1-y1)/float(y2-y1));
			if (y1<1) {y1=1;x1=c;} else if (y2<1) {y2=1;x2=c;};
		}
		if (cc1&4)
		{
			// right clip
			c=y1+(y2-y1)*(float(319-x1)/float(x2-x1));
			if (x1>319) {x1=319;y1=c;} else if (x2>319) {x2=319;y2=c;};
		}
		if (cc1&8)
		{
			// bottom clip
			c=x1+(x2-x1)*(float(199-y1)/float(y2-y1));
			if (y1>199) {y1=199;x1=c;} else if (y2>199) {y2=199;x2=c;};
		}
		if (x1<1) x1=1; else if (x1>319) x1=319;if (y1<1) y1=1; else if (y1>199) y1=199;
		if (x2<1) x2=1; else if (x2>319) x2=319;if (y2<1) y2=1; else if (y2>199) y2=199;
		if (y1==199 && y2==199) return;
        if (y1==0 && y2==0) return;
	}
	unclippedline(x1,y1,x2,y2);
}


void pinsphere(float mat[3][3], float FOC, float nc, float texscale)
{

	// fill in pins
	PIN *p = &pin[0][0];
	SLONG c1,c2;
	float x,y,z,l;

	x = (FOC * mat[2][0]) - 20.5*mat[0][0] - 13*mat[1][0];
	y = (FOC * mat[2][1]) - 20.5*mat[0][1] - 13*mat[1][1];
	z = (FOC * mat[2][2]) - 20.5*mat[0][2] - 13*mat[1][2];

	texscale*=128*256.0;

	for (c1=0;c1<26;c1++)
	{
		for (c2=0;c2<41;c2++,p++)
		{
			l=texscale/sqrt(x*x+y*y+z*z);
			p->u = 128*256+x*l+nc;
			p->v = 128*256+y*l;
			x+=mat[0][0];
			y+=mat[0][1];
			z+=mat[0][2];
		}
		x+=mat[1][0]-41*mat[0][0];
		y+=mat[1][1]-41*mat[0][1];
		z+=mat[1][2]-41*mat[0][2];
	}
}


// font

//char fontstr[];//="{}()-:;@+'abcdefghijklmnopqrstuvwxyz0123456789";

unsigned char fontmap[256];
unsigned char *fontbmp;
unsigned char *fontptr[256];
int fontwid[256];

int fontblank(int x)
{
	if (x<0 || x>=FONTWID) return 1;
	unsigned char *b=fontbmp+x;
	for (int c1=0;c1<FONTHGT;c1++,b+=FONTWID) if (*b) return 0;
	return 1;
}

void loadfont()
{

	LFILE *f;
	f=openf((unsigned char*)"data\\font.raw");
	fontbmp=new unsigned char[FONTWID*FONTHGT];
	readf(f,fontbmp,FONTWID*FONTHGT);
	closef(f);
	memset(fontmap,255,256);
	int x=0,x1=0;

	for (int c1=0;c1<NUMCHARS;c1++)
	{
		while (fontblank(x)) x++;
		x1=x;
		while (!fontblank(x)) x++;
		fontmap[fontstr[c1]]=c1;
		fontptr[c1]=fontbmp+x1;
		fontwid[c1]=x-x1;
	}
	fontwid[255]=5;
}

void fontwrite(unsigned char *dest, unsigned char *str, int pitch)
{
	int y,w,c;
	while (*str)
	{
		c=fontmap[*str];
		unsigned char *d=dest;
		dest+=(w=fontwid[c]+1);
		if (c==255)
		{
			for (y=0;y<FONTHGT;y++,d+=pitch) memset(d,0,w);
		} else {
			unsigned char *s=(unsigned char*)fontptr[c];
			for (y=0;y<FONTHGT;y++,d+=pitch,s+=FONTWID) memcpy(d,s,w);
		}
		str++;
	}
}

int strwid(unsigned char *str)
{
	int c=0;
	while (*str) c+=fontwid[fontmap[*str++]]+1;
	return c;
}


//////////////////////////////////////////////////////////////////////
// 3d engine...... hahahaha


#define GRID 17



#define MAXBUK 2048// (GRID*GRID)	// at least grid*grid
#define MINZ 0.4f
#define SCALE 230.f
#define TPOOLSIZE 10000
#define PPOOLSIZE 5000

float *cube;
TRI *bucket[MAXBUK];
TRI	*tpool,*tpoolstart,*tpoolend;
P3D *ppool,*ppoolstart,*ppoolend;
T3D *vpool,*vpoolstart,*vpoolend;

void init3d()
{
	return;
	vpoolstart=vpool=new T3D[PPOOLSIZE];
	vpoolend=vpool+PPOOLSIZE;
	ppoolstart=ppool=new P3D[PPOOLSIZE];
	ppoolend=ppool+PPOOLSIZE;
	tpoolstart=tpool=new TRI[TPOOLSIZE];
	tpoolend=tpool+TPOOLSIZE;
}

void close3d()
{
	delete [] vpoolstart;
	delete [] ppoolstart;
	delete [] tpoolstart;
}

void startframe3d()
{
	vpool=vpoolstart;
	tpool=tpoolstart;
	ppool=ppoolstart;
}

void calcnormals(T3D *pts, TRI *tris, int nump, int numt)
{
	TRI *t=tris,*et=tris+numt;
	T3D *p=pts,*ep=pts+nump;
	for (;t<et;t++)
	{
		// compute face normals
		FVector a=t->a->p-t->b->p;
		FVector b=t->c->p-t->b->p;
		t->n=(a^b);t->n.Normalise();
	}
	for (;p<ep;p++)
	{
		p->n=FVector(0,0,0);
		for (t=tris;t<et;t++) if (t->ta==p || t->tb==p || t->tc==p) p->n+=t->n;
		p->n.Normalise();
	}
}

void buckettris(P3D *pts, TRI *tris, CAM *cam, int nump, int numt)
{
	// draws a bucketed bunch of pts and tris
	P3D *p=pts,*ep=pts+nump;
	int buk,zc;

	for (;p<ep;p++)
	{
		p->rp=cam->axes*(p->p-cam->posn);
		if (p->rp.Z>MINZ)
		{
			float f=SCALE/p->rp.Z;
			p->px=f*p->rp.X+160;
			p->py=f*p->rp.Y+100;
		}
	}

	TRI *t=tris,*et=tris+numt;
	for (;t<et;t++)
	{
		zc=(t->a->rp.Z<MINZ)+(t->b->rp.Z<MINZ)+(t->c->rp.Z<MINZ);
		if (zc==3) continue;
		if (zc==0)
		{
			zc= (t->a->px>=320)+(t->b->px>=320)+(t->c->px>=320)-
			   ((t->a->px<0)+(t->b->px<0)+(t->c->px<0));
			if (zc==-3 || zc==3) continue;
			zc= (t->a->py>=200)+(t->b->py>=200)+(t->c->py>=200)-
			   ((t->a->py<0)+(t->b->py<0)+(t->c->py<0));
			if (zc==-3 || zc==3) continue;
			buk=(int)t->next;
			if (buk<0) buk=0; else if (buk>=MAXBUK) buk=MAXBUK-1;
			t->next=bucket[buk];
			bucket[buk]=t;
		}
		else
		{
		/*
			// z clip      +
			zc=(t->c->rp.Z>=MINZ);
			int op=0;
			P3D *outp[8];

			if (t->a->rp.Z>=MINZ)
			{
				if (!zc) {
					t->a->rp+((t->c->rp-t->a->rp)*((MINZ-t->a->rp.Z)/(t->c->rp.Z-t->a->rp.Z)));
					outp[op++]=ppool++;
				}
				outp[op++]=t->a;
				zc=1;
			}
		*/
		}
	}
}


void drawtris1()
{
	TRI *b,*p;



	static int plp[3][2];
	static int plp2[3];
	for (int c1=MAXBUK-1;c1>=0;c1--)
	{
		for (b=bucket[c1];b;b=b->next)
		{


			plp[0][0]=b->a->px;plp[0][1]=b->a->py;
			plp[1][0]=b->b->px;plp[1][1]=b->b->py;
			plp[2][0]=b->c->px;plp[2][1]=b->c->py;
			float f=9.f/(b->a->rp.Z);
			if (f<1) b->c2=b->c1*f; else b->c2=b->c1;

			if (flattri(screenbuf,plp,b->c2)>0)
			{
				plp2[0]=(MINZ*300)/b->a->rp.Z;if (plp2[0]>252) plp2[0]=252;
				plp2[1]=(MINZ*300)/b->b->rp.Z;if (plp2[1]>252) plp2[1]=252;
				plp2[2]=(MINZ*300)/b->c->rp.Z;if (plp2[2]>252) plp2[2]=252;
				gouraudfill(zbuf,plp2,plp);
				linecol=8*f;if (linecol>28) linecol=28;
				if (linecol>1)
				{
					//for (int i=0;i<3;i++) putpixel(plp[i][0],plp[i][1],plp2[i]);
					line(plp[0][0],plp[0][1],plp[1][0],plp[1][1]);
					line(plp[2][0],plp[2][1],plp[1][0],plp[1][1]);
					line(plp[0][0],plp[0][1],plp[2][0],plp[2][1]);
				}
			}


		}
		bucket[c1]=NULL;
	}
}


P3D *cubp;
P3D *cubp2;
TRI *cubt;
int numcubp=GRID*GRID*4+(GRID+1)*(GRID+1);
int numcubt=GRID*GRID*10;


void bucketcubes(float time)
{
	int y,dy,yc,x,dx,xc,bc,c1,camx,camy;
	y=0;
	dy=1;
	yc=GRID;
	bc=MAXBUK-1;
	camx=floor(mycam.posn.X)+int(GRID/2);
	camy=floor(mycam.posn.Y)+int(GRID/2);
	while (yc--)
	{
		if (y>=camy && dy>0) {y=GRID-1;dy=-dy;};
		xc=GRID;
		x=0;dx=1;
		while (xc--)
		{
			if (x>=camx && dx>0) {x=GRID-1;dx=-dx;};
			if (1)
			{
				int i=x*GRID+y;
				P3D *p=cubp2+4*(i);
				TRI *t=cubt+10*(i);

				float *fp=cube+i*4;
				float z=fp[0]*(1.05+sin(fp[1]+fp[2]*time));//+sin(fp[1]-fp[3]*time)*0.5

				int c2=x-GRID/2;
				int c1=y-GRID/2;
				p->p=FVector(c2  ,c1  ,z);p++;
				p->p=FVector(c2  ,c1+1,z);p++;
				p->p=FVector(c2+1,c1+1,z);p++;
				p->p=FVector(c2+1,c1  ,z);
				for (c1=0;c1<10;c1++,t++) t->next=(TRI*)bc;
				bc--;
			}
			x+=dx;
		}
		y+=dy;
	}
}

void setupcubes()
{
	cubp=new P3D[numcubp];
	cubt=new TRI[numcubt];
	cube=new float[GRID*GRID*4];

	P3D *p=cubp;
	TRI *t=cubt;
	int c1,c2;

	float *df=cube;
	for (c2=0;c2<GRID;c2++)
	for (c1=0;c1<GRID;c1++)
	{
		*df++=-rand()/27000.f-0.1;						// amplitude
		*df++=rand()/1700.f;							// phase
		*df++=(rand()-16384)/17000.f;					// frequency
		*df++=df[-1]*(1+(rand()-16384)/17000.f);		// frequency2
	}


	for (c2=0;c2<GRID+1;c2++)
	for (c1=0;c1<GRID+1;c1++)
	{
		// ground points
		p->p=FVector(c2-int(GRID/2),c1-int(GRID/2),0);p++;
	}
	cubp2=p;
	for (c2=0;c2<GRID;c2++)
	for (c1=0;c1<GRID;c1++)
	{
		P3D *p2=&cubp[c2*(GRID+1)+c1];
		t->b=&p [0];	t->a=&p [1];t->c=&p [2];t++;	// top
		t->b=&p [2];	t->a=&p [3];t->c=&p [0];t++;
		t->b=&p [1];	t->a=&p [0];t->c=&p2[0];t++;    // north
		t->b=&p2[0];	t->a=&p2[1];t->c=&p [1];t++;
		t->b=&p [2];	t->a=&p [1];t->c=&p2[1];t++;	// east
		t->b=&p2[1];	t->a=&p2[2+GRID];t->c=&p [2];t++;
		t->b=&p [3];	t->a=&p [2];t->c=&p2[GRID+2];t++; // south
		t->b=&p2[GRID+2];t->a=&p2[GRID+1];t->c=&p[3];t++;
		t->b=&p [0];	t->a=&p [3];t->c=&p2[GRID+1];t++; // west
		t->b=&p2[GRID+1];t->a=&p2[0];t->c=&p[0];t++;
		float z=-0.1;
		p->p=FVector(c2-GRID/2  ,c1-GRID/2  ,z);p++;
		p->p=FVector(c2-GRID/2  ,c1-GRID/2+1,z);p++;
		p->p=FVector(c2-GRID/2+1,c1-GRID/2+1,z);p++;
		p->p=FVector(c2-GRID/2+1,c1-GRID/2  ,z);p++;
	}

	t=cubt;
	TRI *et=t+numcubt;
	for (;t<et;t++)
	{
		// compute face normals
		FVector a=t->a->p-t->b->p;
		FVector b=t->c->p-t->b->p;
		t->n=(a^b);t->n.Normalise();
		t->c1=30.f*(1+(t->n.X+2*t->n.Y+3*t->n.Z)/4)+rand()/10000;
		if (t->c1>255) t->c1=255;
		t->c1>>=1;

	}

	mycam.posn=FVector(4,4,-8);
	mycam.axes.MakeID();

	calcfocus(40, 12);
	memset(bucket,0,sizeof(bucket));
}

void makecubespartfp()
{



	setupcubes();
	int c1,c2;

	for (c1=0;c1<128;c1++)
	{
		c2=int((c1/8.0)*4.f*4);if (c2>63) c2=63;
		mypal[c1][2]=c2;
		c2=int((c1/8.0)*2.f*4);if (c2>63) c2=63;
		mypal[c1][1]=c2;
		c2=int((c1/8.0)*1.f*4);if (c2>63) c2=63;
		mypal[c1][0]=c2;
	}

	//computefade("data\\cube.fad");
	readfade((unsigned char*)"data\\cube.fad");

	static float time=35;

	GetMouseV();

	curfp=fpl=0;
	fpname=(unsigned char*)"data\\cubes.fpl";


	addfproc(ynoisefproc);

	setpalrev(60);

	int quit=0;
	memset(bucket,0,sizeof(bucket));
	while (!quit)
	{

		GetMouseV();
		GetMouse();
		FMatrix h;h.MakeYRot(mxv/1000.0f);
		FMatrix g;g.MakeXRot(myv/1000.0f);
		mycam.axes=(g*h)*mycam.axes;
		if (mb==1) 	mycam.posn=mycam.posn+mycam.axes.Row[2]*0.25;
		if (mb==2) 	mycam.posn=mycam.posn-mycam.axes.Row[2]*0.25;

		memset(screenbuf,0,64000);
		memset(zbuf,0,64000);

		int dt;
		time+=0.0071*(dt=dofproc());
		time=time-int(time)+curfp;
		bucketcubes(time);
		buckettris(cubp,cubt,&mycam,numcubp,numcubt);

		drawtris1();
		clearblurborder(screenbuf+64000); blurproc(screenbuf+64000,screenbuf);
		clearblurborder(screenbuf+128000); blurproc(screenbuf+128000,screenbuf+64000);
		blendproc(screenbuf,zbuf,screenbuf);

		calcynoise(ycols,34,2,-3);noisefade(screenbuf,ycols,rand());
		//quantum(tex[5],screenbuf,rand());

		memset(screenbuf,0,320*4);
		memset(screenbuf+196*320,0,320*4);
		swapscreens(screenbuf);

		unsigned char str[128];
		sprintf((char*)str,"step %d of %d   ",curfp+1,fpl);
		monow(160*10,str);
		if (kbhit())
		{
			unsigned char ch=getch();
			switch (ch)
			{
			case 27:
				quit=1;
				break;
			default:
				processkey(ch,&mycam);
				break;
			}
		}
	}
	removefproc(ynoisefproc);


	delete []cubp;
	delete []cubt;
	delete []cube;
}

void makerle(void *dest, void *src)
{
	int c,cc;
	unsigned char *d=(unsigned char*)dest;
	unsigned char *s=(unsigned char*)src;
	unsigned char *es=s+64000;
	do
	{
		c=0;
		if (s[0]>=253)
		{
			cc=s[0];
			while (c<255 && s<es && s[0]==cc) {c++;s++;}
			*d++=cc;
			*d++=c;
		} else {
			*d++=*s++;
			unsigned char *d2=d++;
			while (c<255 && s<es && s[0]<253) {c++;*d++=*s++;}
			d2[0]=c;
		}
	} while (s<es);
}

// src2 is reverse palette
void drawrle(void *dest, void *src, void *src2)
{
	int c,cc;
	unsigned char *d=(unsigned char*)dest;
	unsigned char *s=(unsigned char*)src;
	unsigned char *s2=(unsigned char*)src2;
	unsigned char *ed=d+64000;
	do
	{
		cc=*s++;
		if (cc>=253)
		{
			// transparent
			c=*s++;
			d+=c;
		}
		else
		/*if (cc>=254)
		{
			// inverse
			c=*s++;
			while (c--) {*d=s2[*d];d++;}
		}
		else*/
		{
			// opaque
			*d++=cc;
			c=*s++;
			memcpy(d,s,c);
			s+=c;
			d+=c;
		}
	} while (d<ed);
}

void addsat(void *dest, void *src)
{
	unsigned char*d=(unsigned char*)dest;
	unsigned char*s=(unsigned char*)src;
	for (int c1=0;c1<64000;c1++)
	{
		*d=cliptab128[*d+*s++];d++;
	}
}

unsigned char mypal2[256][3];
unsigned char mypali[256];


void saturatefproc()
{
	static float f=0;
	static int orr=0;
	if (orr!=curpos)
	{
		orr=curpos;
		f=f*0.8;
		if ((orr&7)==0) f=2;
		if ((orr&15)==0) f=3;
	}
	for (int c1=0;c1<256;c1++)
	for (int c2=0;c2<3;c2++)
	{
		int i=mypali[c1]+(mypal[c1][c2]-mypali[c1])*f;
		if (i<0) i=0;if (i>63) i=63;
		mypal2[c1][c2]=i;
	}
	setpal(mypal2);
}

void setupsaturatefproc()
{
	for (int c1=0;c1<256;c1++) mypali[c1]=(mypal[c1][0]*30+mypal[c1][1]*56+mypal[c1][2]*14)/100;
	addfproc(saturatefproc,1);
}
extern "C" unsigned char divide21[];

void cubespart()
{
	{
		for (int c1=0;c1<256*21;c1++)
		{
			divide21[c1]=c1/21;
		}
	}
	setpalwhite();
	palpos=1;
	paldest=0.999;
	palspd=1/60;
	palupdate++;

	setupcubes();
	int c1,c2;

	LFILE *f=openf((unsigned char*)"data\\gray16.raw");
	readf(f,tex[5],64000);
	for (c1=0;c1<64000;c1++) tex[5][c1]=(tex[5][c1]&15)*5;
	closef(f);
	int *cumpic=new int[320*240];
	makecum(cumpic,tex[5],200);


	f=openf((unsigned char*)"data\\back2.raw");
	readf(f,mypal,768);
	closef(f);

	f=openf((unsigned char*)"data\\rayes.raw");
	readf(f,tex[5],64000);

	// turn it upside down

	unsigned char *tempmem=new unsigned char[64000];
	for (c1=0;c1<200;c1++) memcpy(&tempmem[c1*320],((unsigned char*)tex[5])+(199-c1)*320,320);
	memcpy(tex[5],tempmem,64000);
	delete [] tempmem;

	closef(f);



	//computefade("data\\cube.fad");
	readfade((unsigned char*)"data\\cube.fad");

	static float time=0;
	float time2=0;

	fpname=(unsigned char*)"data\\cubes.fpl";
	loadfp(fpname);
	fpath[0]=fpath[1];


	//setupsaturatefproc();
	addfproc(ynoisefproc);
	dofproc();

	int quit=0;
	int mode=0;
	float mant=0;
	float manf=1;
	float skelf=32;

	memset(screenbuf,0,64000);
	swapscreens();

	setpalrev(60);

	while (!kbhit() && curpos<CUBESEND)
	{
		memset(screenbuf,0,64000);
		memset(zbuf,0,64000);

		int dt;
		dt=dofproc();
		time+=0.0071*(dt);
		if ((curpos&32)==0 || curpos<(CUBESSTART+64))
		{
			time2+=0.0091*(dt);
		}
		else
		{
			time2+=4*(0.0491-(curpos&31)*0.001)*(dt);
		}

		if (time>fpl) time=fpl;

		interpolate(time,&mycam);

		bucketcubes(time2);
		buckettris(cubp,cubt,&mycam,numcubp,numcubt);

		drawtris1();
		clearblurborder(screenbuf+64000); blurproc(screenbuf+64000,screenbuf);
		clearblurborder(screenbuf+128000); blurproc(screenbuf+128000,screenbuf+64000);
		//memcpy(screenbuf,screenbuf+64000,64000);
		blendproc(screenbuf,zbuf,screenbuf);

		calcynoise(ycols,34,2,-3);
		noisefadeblack(screenbuf,ycols,rand());
		//quantum(tex[5],screenbuf,rand());

		memset(screenbuf,0,320*4);
		memset(screenbuf+196*320,0,320*4);

		// blurring man
		if (curpos>=MANSTART && mode<2)
		{
			if (mode==0) mode=1;
			mant+=dt*0.064;
			if (curpos>MANEND) manf-=dt*0.0051;
			if (manf<0) manf=0;

			float t2=4*(1-cos(mant*1.5))*manf;
			float bl=exp(-t2*t2*0.1)*100-1;if (bl<0) bl=0;
			blurcum(screenbuf+64000,cumpic,bl+SQR(rand()&3)/3,bl+SQR(rand()&3)/3,bl+1.5f+SQR(rand()&3)/3,bl+1.5f+SQR(rand()&3)/3,256-bl*2);
			composelight(screenbuf,screenbuf+64000,fadeptr);
		}
		if (curpos>=SKELSTART)
		{
			if (mode<2)
			{
				mode=2;
				setpalrev(100);

			}
			skelf*=pow(0.97,dt*0.3);
			if ((rand()&255)<7) skelf+=fabs(frand(0.3));
			c1=(skelf+(rand()&3))*3;
			if (c1>127) c1=127;
			unsigned char *s=(unsigned char*)tex[5];
			unsigned char *d=(unsigned char*)screenbuf+64000;
			unsigned char *l=(unsigned char*)multab+256*c1;
			for (c1=0;c1<64000;c1++) *d++=l[255-*s++];
			composelight(screenbuf,screenbuf+64000,fadeptr);
		}


		swapscreens(screenbuf);
	}
	removefproc(ynoisefproc);
	//removefproc(saturatefproc);


	delete [] cumpic;
	delete []cubp;
	delete []cubt;
	delete []cube;
}



void cubespart2()
{
	setpalwhite();
	palpos=1;
	paldest=0.999;
	palspd=1/60;
	palupdate++;

	setupcubes();
	int c1,c2;

	LFILE *f=openf((unsigned char*)"data\\back2.raw");
	readf(f,mypal,768);
	closef(f);

	static float time=0;
	float time2=0;

	fpname=(unsigned char*)"data\\cubes.fpl";
	loadfp(fpname);
	fpath[0]=fpath[1];

	addfproc(ynoisefproc);
	dofproc();

	int quit=0;
	int mode=0;
	float mant=0;
	float manf=1;
	float skelf=32;

	memset(screenbuf,0,64000);
	swapscreens();

	setpalrev(60);

	int cp=curpos/16;

	while (!kbhit() && curpos<CUBES2END)
	{
		memset(screenbuf,0,64000);
		memset(zbuf,0,64000);

		while (cp<curpos/16)
		{
			palpos=1;
			palrev=!palrev;
			palspd=1/30.f;
			cp=curpos/16;

			//palpos+=frand(1);
		}

		int dt;
		dt=dofproc();
		time+=0.0071*(dt);
		if ((curpos&32)==0 || curpos<(CUBESSTART+64))
		{
			time2+=0.0091*(dt);
		}
		else
		{
			time2+=4*(0.0491-(curpos&31)*0.001)*(dt);
		}

		if (time>fpl) time=fpl;

		interpolate(time,&mycam);

		bucketcubes(time2);
		buckettris(cubp,cubt,&mycam,numcubp,numcubt);

		drawtris1();
		clearblurborder(screenbuf+64000); blurproc(screenbuf+64000,screenbuf);
		clearblurborder(screenbuf+128000); blurproc(screenbuf+128000,screenbuf+64000);
		blendproc(screenbuf,zbuf,screenbuf);

		calcynoise(ycols,34,2,-3);noisefadeblack(screenbuf,ycols,rand());
		quantum(tex[5],screenbuf,rand());

		memset(tex[5],0,320*4);
		memset(tex[5]+196*320,0,320*4);

		{
		float t=time;
		RadialBlur((unsigned char*)tex[5], 160+50*getwibble(134,t),100+50*getwibble(72,t), 0.4, -0.025);
		unsigned char *s=(unsigned char*)tex[5];
		for (c1=0;c1<64000;c1++,s++) *s=cliptab128[*s];
		}

		swapscreens(tex[5]);
	}
	removefproc(ynoisefproc);
	//removefproc(saturatefproc);

	memset(screenbuf,0,64000);swapscreens();swapscreens();


	delete []cubp;
	delete []cubt;
	delete []cube;
}


//////////////////////////////////////////////////////////////////////
// sphere part
P3D *sphp;
TRI *spht;
T3D *sphv;
int numsphp;
int numspht;
#define SPHROW 32
#define SPHCOL 32
#define SPHR 4
#define LIGHTSCALE 1.7

void calcsphere()
{
	P3D *p;
	TRI *t;
	T3D *v;
	int c1,c2,c3;

	p=sphp=new P3D[(numsphp=(SPHROW-1)*SPHCOL+2)];
	t=spht=new TRI[(numspht=(SPHROW-1)*SPHCOL*2)];
	v=sphv=new T3D[(SPHROW)*SPHCOL+2];

	// poles
	v->u=128;v->v=128;p->p=FVector(0,0,-SPHR);v->c=16;p++;v++;
	v->u=128;v->v=128;p->p=FVector(0,0,SPHR); v->c=50;p++;v++;
	// middle vertices
	for (c1=1;c1<SPHROW;c1++)
	{
		float r=SPHR*sin(c1*PI/SPHROW);
		float z=SPHR*-cos(c1*PI/SPHROW);
		for (c2=0;c2<SPHCOL;c2++)
		{
			p->p=FVector(-r*sin(c2*PI*2/SPHCOL),r*cos(c2*PI*2/SPHCOL),z);
			c3=(c1-(SPHROW/2-2))*3+30;if (c3>50) c3=50;
			v->c=(c1>SPHROW/2-1)?c3:16;
			v->u=128+120*p->p.X/SPHR;
			v->v=128+120*p->p.Y/SPHR;
			p++;v++;
		}
	}

	for (c1=0;c1<SPHCOL;c1++)
	{
		// cap
		t->a= &sphp[0];t->b= &sphp[2+c1];t->c =&sphp[2+((c1+1)%SPHCOL)];
		t->ta=&sphv[0];t->tb=&sphv[2+c1];t->tc=&sphv[2+((c1+1)%SPHCOL)];
		t++;
	}
	for (c2=0;c2<SPHROW-2;c2++)
	for (c1=0;c1<SPHCOL;c1++)
	{
		// rows
		t->a= &sphp[2+c2*SPHCOL+c1];t->b= &sphp[2+(c2+1)*SPHCOL+c1];t->c =&sphp[2+(c2+1)*SPHCOL+((c1+1)%SPHCOL)];
		t->ta=&sphv[2+c2*SPHCOL+c1];t->tb=&sphv[2+(c2+1)*SPHCOL+c1];t->tc=&sphv[2+(c2+1)*SPHCOL+((c1+1)%SPHCOL)];
		t++;
		t->a= &sphp[2+(c2+1)*SPHCOL+((c1+1)%SPHCOL)];t->b= &sphp[2+c2*SPHCOL+((c1+1)%SPHCOL)];t->c =&sphp[2+c2*SPHCOL+c1];
		t->ta=&sphv[2+(c2+1)*SPHCOL+((c1+1)%SPHCOL)];t->tb=&sphv[2+c2*SPHCOL+((c1+1)%SPHCOL)];t->tc=&sphv[2+c2*SPHCOL+c1];
		t++;
	}

	for (c1=0;c1<SPHCOL;c1++)
	{
		// cap
		t->a= &sphp[1];t->c= &sphp[2+(SPHROW-2)*SPHCOL+c1];t->b =&sphp[2+(SPHROW-2)*SPHCOL+((c1+1)%SPHCOL)];
		t->ta=&sphv[1];t->tc=&sphv[2+(SPHROW-2)*SPHCOL+c1];t->tb=&sphv[2+(SPHROW-2)*SPHCOL+((c1+1)%SPHCOL)];
		t++;
	}
	calcnormals(sphv,spht,numsphp,numspht);
}





void drawsphere(float theta)
{

	P3D *p=sphp,*ep=sphp+numsphp;

	CAM *cam=&mycam;
	//FMatrix sphspin;sphspin.MakeYRot(theta);

	for (;p<ep;p++)
	{
		p->rp=cam->axes*((p->p)-cam->posn);
		if (p->rp.Z>MINZ)
		{
			float f=SCALE/p->rp.Z;
			p->px=f*p->rp.X+160;
			p->py=f*p->rp.Y+100;
			//putpixel(p->px,p->py,255);
		} else p->px=p->py=0;
	}
	int plp[3][2];
	int plp2[12];

	TRI *t=spht,*et=spht+SPHCOL*(SPHROW-3);
	for (;t<et;t++)
	{

		if (t->a->rp.Z>MINZ && t->b->rp.Z>MINZ && t->c->rp.Z>MINZ)
		{
			plp[0][0]=t->a->px;plp[0][1]=t->a->py;
			plp[1][0]=t->b->px;plp[1][1]=t->b->py;
			plp[2][0]=t->c->px;plp[2][1]=t->c->py;
			flattri(screenbuf,plp,fadeptr[0]);



			if (linecol)
			{

				screenbuf+=64000;
				line(plp[0][0],plp[0][1],plp[1][0],plp[1][1]);
				line(plp[2][0],plp[2][1],plp[1][0],plp[1][1]);
				line(plp[0][0],plp[0][1],plp[2][0],plp[2][1]);
				screenbuf-=64000;
			}
		}
	}
	et=spht+numspht;
	for (;t<et;t++)
	{
		if (t->a->rp.Z>MINZ && t->b->rp.Z>MINZ && t->c->rp.Z>MINZ)
		{
			plp[0][0]=t->a->px;plp[0][1]=t->a->py;
			plp[1][0]=t->b->px;plp[1][1]=t->b->py;
			plp[2][0]=t->c->px;plp[2][1]=t->c->py;
			if (flattri(0,plp,0)>0)
			{
				plp2[0]=t->ta->c;plp2[1]=t->tb->c;plp2[2]=t->tc->c;
				plp2[3]=t->ta->u;plp2[4]=t->tb->u;plp2[5]=t->tc->u;
				plp2[6]=t->ta->v;plp2[7]=t->tb->v;plp2[8]=t->tc->v;
				texgoufill(screenbuf,plp2,plp);
				//gouraudfill(screenbuf,plp2,plp);
				if (linecol)
				{

					screenbuf+=64000;
					line(plp[0][0],plp[0][1],plp[1][0],plp[1][1]);
					line(plp[2][0],plp[2][1],plp[1][0],plp[1][1]);
					line(plp[0][0],plp[0][1],plp[2][0],plp[2][1]);
					screenbuf-=64000;
				}

			}
		}
	}


}

void drawsphere2(CAM *cam, float vh)
{

	P3D *p=sphp,*ep=sphp+numsphp;


	//FMatrix sphspin;sphspin.MakeYRot(theta);

	#define MINZ3 0.5

	for (;p<ep;p++)
	{
		p->rp=(cam->axes*((FVector(p->p.X,p->p.Y*vh,p->p.Z))-cam->posn));
		//p->rp=p->rp*(60.f/4.f);
		if (p->rp.Z>MINZ3)
		{
			float f=SCALE/p->rp.Z;
			p->px=f*p->rp.X+160;
			p->py=f*p->rp.Y+100;
			//putpixel(p->px,p->py,255);
		} else p->px=p->py=0;
	}
	int plp[3][2];
	int plp2[12];

	TRI *t=spht,*et=spht+numspht;
	for (;t<et;t++)
	{

		if (t->a->rp.Z>MINZ3 && t->b->rp.Z>MINZ3 && t->c->rp.Z>MINZ3)
		{
			plp[0][0]=t->a->px;plp[0][1]=t->a->py;
			plp[1][0]=t->b->px;plp[1][1]=t->b->py;
			plp[2][0]=t->c->px;plp[2][1]=t->c->py;
			if (flattri(0,plp,0)>0)
			{

				line(plp[0][0],plp[0][1],plp[1][0],plp[1][1]);
				line(plp[2][0],plp[2][1],plp[1][0],plp[1][1]);
				line(plp[0][0],plp[0][1],plp[2][0],plp[2][1]);
			}
		}
	}
}


float spwav[8][16];

void initspwav()
{
	int c1,c2;
	for (c1=0;c1<8;c1++)
	{
		for (c2=1;c2<8;c2++) spwav[c1][c2]=(rand()/32768.0f-0.5f)*2;
		float f=spwav[c1][1]+spwav[c1][2]+spwav[c1][3]+spwav[c1][4]+
		  spwav[c1][5]+spwav[c1][6]+spwav[c1][7]+spwav[c1][8];
		spwav[c1][0]=20.f/(fabs(f)+1);


	}
}

void calcuvs(float t)
{

	PIN *p = &pin[0][0];
	SLONG c0,c2;
	float x,y;

	for (c0=0;c0<33;c0++)
	{
		for (c2=0;c2<33;c2++,p++)
		{
			x=(c0-16.5f);
			y=(c2-16.5f);

			int c1;

			float uu=128+20*x+t;
			float vv=128+20*y-t*30;
			for (c1=0;c1<4;c1++)
			{
				uu+=spwav[c1][0]*(sin(spwav[c1][1]*x+spwav[c1][2]*t)
								+cos(spwav[c1][3]*y+spwav[c1][4]*t));
				vv+=spwav[c1][0]*(sin(spwav[c1][5]*x+spwav[c1][6]*t)
								+cos(spwav[c1][7]*y+spwav[c1][8]*t));

			}
			p->u=256*uu;
			p->v=256*vv;
		}
	}
	drawpinmaptex(tex[1],texptr);
}

UBYTE *flare,*sunflare;

void drawborders(int m=0, int c=255)
{
	if (c>255) c=255;
	if (c<0) c=0;
	if (m<0) m=0;
	if (m>20) m=20;
	int m2=(20-m)*320;m*=320;
	memset(&wina000[0][0],0,m2);
	memset(&wina000[0][m2],c,m);
	memset(&wina000[220][0],c,m);
	memset(&wina000[220][m],0,m2);
}

void writecam(CAM *cam)
{
	unsigned char str[2094];
	sprintf((char*)str,"%0.4f %0.4f %0.4f\n%0.4f %0.4f %0.4f\n%0.4f %0.4f %0.4f\n%0.4f %0.4f %0.4f\n",
				cam->axes.Row[0].X,cam->axes.Row[0].Y,cam->axes.Row[0].Z,
				cam->axes.Row[1].X,cam->axes.Row[1].Y,cam->axes.Row[1].Z,
				cam->axes.Row[2].X,cam->axes.Row[2].Y,cam->axes.Row[2].Z,
				cam->posn.X,cam->posn.Y,cam->posn.Z);
	monow(40,str);
}

void spherepart()
{
	int c1,c2,c3;
	static unsigned char mclip[512];

	palpos=paldest=0;
	palspd=0;
	palupdate=0;

	texptr=tex[0];


	LFILE *ff=openf((unsigned char*)"data\\pulse.raw");
	unsigned char *logo=new unsigned char[64000];
	readf(ff,logo,64000);
	for (c1=0;c1<64000;c1++) logo[c1]>>=1;
	closef(ff);
	int *cumpic=new int[320*200];
	makecum(cumpic,logo,200);
	loadorb((unsigned char*)"data\\pulse.orb");
	float textt=-12;
	int texton=1;

	// plasma
	unsigned char *plasma=new unsigned char[65536];
	ff=openf((unsigned char*)"data\\plasma.raw");
	readf(ff,plasma,65536);
	closef(ff);



	// flare sprite
	sunflare=tex[3];
	flare=new UBYTE[128*128];
	for (c1=0;c1<128;c1++)
	for (c2=0;c2<128;c2++)
	{
		c3=512-8*exp(log(1+SQR(c1-64)+SQR(c2-64))/2);
		if (c3<0) c3=0;
		if (SQR(c1-64)+SQR(c2-64)>64*64) c3=0;
		if (c3>255) c3=255;
		flare[c2*128+c1]=c3/2;
	}



	initspwav();
	light=FVector(0,0,23);
	mycam.posn=FVector(-6,0.2,-8);
	mycam.axes.MakeYRot(PI/8.5);

	float theta=0;



	LFILE *f=openf((unsigned char*)"data\\plnt.raw");
	readf(f,mypal[128],384);
	readf(f,mypal[0],384);
	readf(f,tex[1],65536);
	readf(f,tex[2],65536);
	for (c1=0;c1<65536;c1++) tex[1][c1]=(tex[1][c1]&127)+128;
	for (c1=0;c1<65536;c1++) tex[2][c1]=(tex[2][c1]&127)+128;
	closef(f);
	f=openf((unsigned char*)"data\\sunflare.raw");
	readf(f,sunflare,65536);
	for (c1=0;c1<65536;c1++)
	{
		sunflare[c1]>>=1;
		if (SQR((c1&255)-128)+SQR((c1>>8)-128)>128*128) sunflare[c1]=0;
	}
	closef(f);

	for (c1=0;c1<128;c1++)
	{
		c2=c1/2;if (c2>63) c2=63;mypal[c1][2]=c2;
		c2=c1  ;if (c2>63) c2=63;mypal[c1][1]=c2;
		c2=c1*2;if (c2>63) c2=63;mypal[c1][0]=c2;
	}
	//drawborders(20);

	//computefade("data\\plnt.fad");
	readfade((unsigned char*)"data\\plnt.fad");
	//computeghost("data\\plnt.gst",32,32);
	readghost((unsigned char*)"data\\plnt.gst");

	GetMouseV();

	int lightx,lighty,lightz;
	FVector rlight,rplanet;

	FVector vv(0,0,0);

	// set up two pointers for the blur screen
	unsigned char *b1=(unsigned char*)tex[4]+1024;memset(b1-1024,0,65536);
	unsigned char *b2=(unsigned char*)tex[5]+1024;memset(b2-1024,0,65536);
	unsigned char *b3;



	addfproc(ynoisefproc);

	float wipet=256;
	int quit=0;

//#define MAKEFPATH
	curfp=fpl=0;
	fpname=(unsigned char*)"data\\planet.fpl";
#ifndef MAKEFPATH
	loadfp(fpname);
#endif

	setpalcol(10,20,60, 20);

	theta += 1.63*1.25*0.0031*dofproc();



	while (!quit)
	{
#ifdef MAKEFPATH
		GetMouseV();
		GetMouse();
		FMatrix h;h.MakeYRot(mxv/1000.0f);
		FMatrix g;g.MakeXRot(myv/1000.0f);
		mycam.axes=(g*h)*mycam.axes;
		if (mb==1) 	vv=vv+mycam.axes.Row[2]*0.25;
		if (mb==2) 	vv=vv-mycam.axes.Row[2]*0.25;
		mycam.posn+=vv*0.5;

		writecam(&mycam);

		vv*=0.22;

		textt=0;
		wipet=0;

		unsigned char str[128];

		sprintf(str,"step %d of %d   ",curfp+1,fpl);
		monow(160*10,str);
		if (kbhit())
		{
			unsigned char ch=getch();
			switch (ch)
			{
			case 27:
				quit=1;
				break;
			default:
				processkey(ch,&mycam);
				break;
			}
		}


#else
		float t=theta*2.2;
		if (t>fpl) t=fpl;
		if (t<0) t=0;
		int spherehandoffframe=takespherehandoff(&mycam); if (!spherehandoffframe) lazyinterpolate(t,&mycam);
		if (kbhit()) quit=1;
		if (curpos>=ENDPLANET-1) quit=1;
#endif

		// screen background

		float mymat[3][3];
		float ang1=theta*3;
		calcfmat(11+cos(ang1/7+532)*3,9-sin(ang1/5.3)*3,&mymat[0][0]);
		pinsphere(mymat,20-15*sin(ang1*1.235+453),theta*3700,1.5);
		drawpinmapns(tex[2],screenbuf);

		noisefade(screenbuf,ycols,rand());


		// add the backlight in and blur it onto main screen
		rlight=mycam.axes*(light-mycam.posn);
		rplanet=mycam.axes*(mycam.posn*-1);
		float f;
		// light behind planet
		if (rlight.Z>MINZ)
		{
			f=SCALE/rlight.Z;
			lightx=160+f*rlight.X;
			lighty=100+f*rlight.Y;
			lightz=f*15*LIGHTSCALE;
			int i=f*3;if (i>255) i=255;
			memset(screenbuf+65024,0,64000);
			scalespr(lightx-lightz,lighty-lightz,lightx+lightz,lighty+lightz,screenbuf+65024,128,128,flare,i);
			ghostcopy(screenbuf,screenbuf+65024);
		}

		// front light
		float i;
		if (rlight.Z>rplanet.Z)
		{
			if (rlight.Z>MINZ)
			{
				// compute perpendicular distance of a vector to the light, from the origin
				FVector d=(light-mycam.posn);
				float lamda=-(mycam.posn*d)/(d.MagnitudeSq());
				d=mycam.posn+d*lamda;
				i=(d.MagnitudeSq()-SQR(SPHR*0.995));
			}
		}
		else
		{
			i=1;
		}
		if (i>0)
		{
			if (i>1) i=1;
			lightz=f*sqrt(i)*9*LIGHTSCALE;
			scalespr(lightx-lightz,lighty-lightz,lightx+lightz,lighty+lightz,b1,256,256,sunflare,i*256);
		}


		//blur and swap
		blurfade(b2,b1);
		b3=b1;b1=b2;b2=b3;

		// draw the sphere
		calcuvs(theta*15);
		linecol=(wipet*20)/256;
		if (linecol)
		{
			memset(screenbuf+64000,0,64000);

		}
		if (spherehandoffframe) { screenbuf+=64000; drawsphere2(&mycam,spherehandoffscale()); screenbuf-=64000; } else drawsphere(theta);

		calcynoise(ycols);
		ghostcopy(screenbuf,b1);

		if (textt>0.2 && texton)
		{
			static int texttime=0;
			float t2=textt;
			float bl=exp(-t2*t2*0.1)*100-1;if (bl<0) bl=0;

			if (bl>0.5)
			{

				blurcum(screenbuf+64000,cumpic,bl+1,bl+1.5,bl,bl,256-bl*2,200,1);
				memset(screenbuf+64000,64,int(bl)*320);
				memset(screenbuf+64000*2-int(bl+1)*320,64,int(bl)*320);



				for (c1=bl;c1<200-bl;c1++)
				{
					memset(screenbuf+64000+c1*320,64,bl);
					memset(screenbuf+64000+c1*320+319-int(bl),64,bl);
				}

			}
			else
			{
				memcpy(screenbuf+64000,logo,64000);
				if (curpos/64!=texttime)
				{
					setpalrev(90);
					texton=0;
				}
			}
			texttime=curpos/64;

			if (texton)
			{

				screenbuf+=64000;
				float orbt=(textt-1.2)*0.7;
				linecol=12;
				draworb(orbt);
				linecol=10;
				draworb(orbt-0.1);
				linecol=8;
				draworb(orbt-0.2);
				screenbuf-=64000;

				//memset(screenbuf+64000,64,64000);
				composelightdark(screenbuf,screenbuf+64000,fadeptr);

			}
		}

		//for (c1=0;c1<64000;c1++) screenbuf[c1]=fadeptr[screenbuf[c1]+47*256];


		int dt=dofproc();
		theta+=1.63*1.25*0.0031*dt;
		textt+=1.63*1.25*0.0125*dt;

		if (linecol>0 && curpos<ENDBJORK+48)
		{
			/*
			int c1,c2,c3;
			c2=wipet*2-256;
			for (c1=0;c1<256;c1++) {c3=c1+c2;if (c3<0) c3=0;if (c3>255) c3=255;mclip[c1]=c3/2;}
			unsigned char *s=(unsigned char*)plasma;
			unsigned char *d=(unsigned char*)tex[4];
			for (c1=0;c1<65536;c1++,s++,d++) *d=mclip[*s];
			calcwibblepins(theta*15,(PIN*)pin,31);
			drawpinmapns(tex[4],screenbuf+64000);
			compose(screenbuf,screenbuf+64000,ghostptr);
			//drawborders(wipet*30/256-11,wipet+128);
			*/

			composelight(screenbuf,screenbuf+64000,fadeptr);

			wipet-=dt*2.8;
			if (wipet<0) wipet=0;


		} else {
			static int moo=1;
			if (moo)
			{
				moo=0;
				//drawborders(0);
			}
		}

		//for (c1=0;c1<200;c1++) memcpy(screenbuf+c1*320,tex[2]+c1*256,256);

		//for (c1=0;c1<100;c1++)
		//for (c2=0;c2<160;c2++) screenbuf[c1*320+c2]=fadeptr[48*256+screenbuf[c1*320+c2]];
		//memcpy(screenbuf+c1*320,fadeptr+c1*256,256);

		swapscreens(screenbuf);
	}

	delete [] plasma;
	delete [] logo;
	delete [] cumpic;
	removefproc(ynoisefproc);
	delete []sphp;
	delete []spht;
	delete []sphv;
	delete []flare;
}
