#include "stdafx.h"
#include "common.h"

unsigned char destpal[256][3];
float palpos=0,paldest=0,palspd=0.01;
int palrev=0,palupdate=0;

void faderfproc()
{
	if (palupdate>0 || palpos!=paldest)
	{
		palupdate--;
		if (palpos<paldest) {palpos+=palspd;if (palpos>paldest) palpos=paldest;} else
		if (palpos>paldest) {palpos-=palspd;if (palpos<paldest) palpos=paldest;}

		float f1=palpos;
		float f2=1-f1;
		int c1,c2,c3;
		unsigned char *mp=(unsigned char*)mypal;
		unsigned char *dp=(unsigned char*)destpal;
		for (c1=0;c1<256;c1++)
		for (c2=0;c2<3;c2++)
		{
			c3=f2* *mp++ + f1* *dp++;
			if (c3<0) c3=0;if (c3>63) c3=63;
//WIN32DONE
			if (palrev) winpal[c1][2-c2]=(63-c3)*4; else winpal[c1][2-c2]=c3*4;			
		}
	}
}

#define FLASHMAC if (flash) \
	{                       \
		palspd=1.f/flash;   \
		if (flash>0) {palpos=1;paldest=0;}\
		if (flash<0) {palpos=0;paldest=1;}\
	}						\
	palupdate=1;

void setpalcol(int r,int g, int b, int flash)
{
	unsigned char *d=(unsigned char*)destpal;
	for (int c1=0;c1<256;c1++)
	{
		*d++=r;
		*d++=g;
		*d++=b;
	}
	FLASHMAC
}

void setpalwhite(int flash)
{
	setpalcol(63,63,63,flash);
}

void setpalblack(int flash)
{
	setpalcol(0,0,0,flash);
}

void setpalburn(int r,int g, int b, int flash)
{
	unsigned char *d=(unsigned char*)destpal;
	unsigned char *s=(unsigned char*)mypal;
	for (int c1=0;c1<256;c1++)
	{
		*d++=*s++ +r;
		*d++=*s++ +g;
		*d++=*s++ +b;
	}
	FLASHMAC
}

void setpalgrey(int flash)
{
	unsigned char *d=(unsigned char*)destpal;
	unsigned char *s=(unsigned char*)mypal;
	for (int c1=0;c1<256;c1++)
	{
		int c2=(*s++ * 30 + *s++ *60 + *s++ *10)/100;
		*d++=c2;
		*d++=c2;
		*d++=c2;
	}
	FLASHMAC
}

void setpalrev(int flash)
{
	unsigned char *d=(unsigned char*)destpal;
	unsigned char *s=(unsigned char*)mypal;
	for (int c1=0;c1<256;c1++)
	{
		*d++=*s++ ^63;
		*d++=*s++ ^63;
		*d++=*s++ ^63;
	}
	FLASHMAC
}

void blurcum(void *dest, int *src, int xn, int yn, int xp, int yp, int f, int maxy, int sgned)
{
	if (f<=0)
	{
		memset(dest,0,maxy*320);
		return;
	}
	int a,sh,x,y,c1,c2;
	int *p1,*p2,*p3,*p4;
	a=(xp+xn)*(yp+yn);
	sh=0;
	while (a>>sh > 32) sh++;
	static unsigned char tab[8192];
	unsigned char *d=tab;
	f=((f*256)<<sh)/a;
	c2=0;
	if (sgned)
	{
		c2=64*65536-(64*a>>sh)*f;
	}
	for (c1=0;c1<8192;c1++,c2+=f) { if (c2<0) c2=0;if (c2>0xffffff) c2=0xffffff;*d++=c2>>16; }
	d=(unsigned char*)dest;
	// yn, yp, xn, xp
	for (y=0;y<maxy;y++)
	{
		int y1,y2;
		y1=y-yn;if (y1<0) y1=0;
		y2=y+yp;if (y2>=maxy) y2=maxy-1;
		p1=src+y1*320;
		p2=p1+xp;
		p3=src+y2*320;
		p4=p3+xp;
		// first xn, then middle, then last xp
		for (x=0;x<xn;x++)
		{
			*d++=tab[(*p1 + *p4 - *p2 - *p3)>>sh];
			p2++;
			p4++;
		}
		for (;x<319-xp;x++)
		{
			*d++=tab[(*p1 + *p4 - *p2 - *p3)>>sh];
			p1++;p2++;
			p3++;p4++;
		}
		for (;x<320;x++)
		{
			*d++=tab[(*p1 + *p4 - *p2 - *p3)>>sh];
			p1++;
			p3++;
		}
	}
}

void makecum(int *dest, void *src,int maxy)
{
	int x,y;
	unsigned char *s=(unsigned char*)src;
	int i=0;
	for (x=0;x<320;x++) {i+=*s++;*dest++=i;}
	for (y=1;y<maxy;y++)
	{
		i=0;
		for (x=0;x<320;x++) {i+=*s++;*dest=i+dest[-320];dest++;}
	}
}



void clear240()
{
	//WIN32DONE outpw(0x3c4,0x0f02);
	memset((void*)wina000,0,sizeof(wina000));
}

void nynaeve()
{
	//LFILE *f=openf("data\\stoned.raw");
	LFILE *f=openf((unsigned char*)"data\\nynaeve.raw");
	readf(f,mypal,768);
	readf(f,tex[0],320*240);
	//memset(tex[0]+320*200,0,320*40);
	closef(f);
	setpal(mypal);

	int *cumpic=new int[320*240];
	makecum(cumpic,tex[0],240);
	float t=0,t2=0;
	dofproc();
	while (!kbhit())
	{
		t2=5*(1-cos(t*0.5));
		float bl=exp(-t2*t2*0.1)*100-1;if (bl<0) bl=0;
		blurcum(screenbuf,cumpic,bl,bl,bl+1.5f,bl+1.5f,256, 240);
		swapscreens2(screenbuf);
		t+=0.02*dofproc();
	}
	getch();
	delete [] cumpic;
	clear240();

	{
	LFILE *f=openf((unsigned char*)"data\\stoned.raw");
	readf(f,mypal,768);
	readf(f,tex[0],320*200);
	closef(f);
	setpal(mypal);

	int *cumpic=new int[320*200];
	makecum(cumpic,tex[0],200);
	float t=0,t2=0;

	dofproc();
	while (!kbhit())
	{
		t2=5*(1-cos(t*0.5));
		float bl=exp(-t2*t2*0.1)*100-1;if (bl<0) bl=0;
		blurcum(screenbuf,cumpic,bl,bl,bl+1.5f,bl+1.5f,256);
		swapscreens(screenbuf);
		t+=0.02*dofproc();
	}

	getch();
	delete [] cumpic;
	}
}


// ar,br,cr=1/sqr(radius)
void pinblob(CAM *cam, FMatrix *lcam, float ar, float br, float cr, float tt, float FOC=10, float shd=1)
{

	// fill in pins
	PIN *p = &pin[0][0];
	SLONG c1,c2,c3;

	FVector vv=cam->axes.Row[2]*FOC-cam->axes.Row[0]*20-cam->axes.Row[1]*12.5;
	FVector vc=cam->posn;
	FVector vy=cam->axes.Row[1]-cam->axes.Row[0]*41;
	FVector vp,n;
	float A,B,C,E;

	C=SQR(vc.X)*ar+SQR(vc.Y)*br+SQR(vc.Z)*cr-1;

	for (c1=0;c1<26;c1++)
	{
		for (c2=0;c2<41;c2++,p++)
		{
			A=SQR(vv.X)*ar+SQR(vv.Y)*br+SQR(vv.Z)*cr;
			B=2*(vv.X*vc.X*ar+vv.Y*vc.Y*br+vv.Z*vc.Z*cr);


			E=B*B-4*A*C;

			float t=(-B+sqrt(fabs(E)))/(2*A);
			vp=vv*t+vc;
			n=vp*(1/vp.Magnitude());

			//p->u = 128*256+getwibble(0,tt+0.2*vp.X)*20000.f;
			//p->v = 128*256+(getwibble(10,tt+0.2*vp.Y)+getwibble(20,tt+0.2*vp.Z))*20000.f;

			p->u = 128*256+ vp.X*900;
			p->v = 128*256+ vp.Z*900;

			if (E>=0.05) {

				int c=22000.f/t;if (c>47*256) c=47*256;



				B=0;
				for (c3=0;c3<3;c3++)
				{
					A=lcam->Row[c3]*n;
					A=A*A;A=A*A;A=A*A-0.3;
					if (A>0) B+=A;
				}
				c+=9000*B-8*256;

				p->col=(c>60*256)?60*256:(c<0)?0:c;
				p->col*=shd;
				p->col+=16*256;
			} else p->col=0;



			vv+=cam->axes.Row[0];
		}
		vv+=vy;
	}
}

void pinblobpart()
{

	LFILE *fi=openf((unsigned char*)"data\\ice.raw");
	readf(fi,mypal,768);
	readf(fi,texptr,65536);
	closef(fi);
	setpal(mypal);

	computefade((unsigned char*)"data\\pinblob.fad");
	readfade((unsigned char*)"data\\pinblob.fad");


	CAM mycam;
	mycam.posn=FVector(0,0,0);
	mycam.axes.MakeID();
	GetMouseV();
	float t=0;

	int c1,c2,c3,c4;


	UBYTE *flare=new UBYTE[64*64];
	for (c1=0;c1<128;c1+=2)
	for (c2=0;c2<128;c2+=2)
	{
		c3=512-8*exp(log(1+SQR(c1-64)+SQR(c2-64))/2);
		if (c3<0) c3=0;
		if (SQR(c1-64)+SQR(c2-64)>64*64) c3=0;
		if (c3>255) c3=255;
		flare[c2*32+c1/2]=c3/2;
	}

	#define NUMBLOB 128
	FVector *blob=new FVector[NUMBLOB];
	for (c1=0;c1<NUMBLOB;c1++) blob[c1]=FVector(c1-8,0,0);//FVector(frand(10),frand(10),frand(10));

	while (!kbhit())
	{
		GetMouseV();
		GetMouse();
		FMatrix h;h.MakeYRot(mxv/1000.0f);
		FMatrix g;g.MakeXRot(myv/1000.0f);
		mycam.axes=(g*h)*mycam.axes;
		if (mb==1) 	mycam.posn=mycam.posn+mycam.axes.Row[2]*1.5;
		if (mb==2) 	mycam.posn=mycam.posn-mycam.axes.Row[2]*1.5;

		h.MakeYRot(getwibble(23,t)*7);
		g.MakeXRot(getwibble(72,t)*7);
		FMatrix lcam=g*h;
		t+=0.1;

		pinblob(&mycam,&lcam,1.f/SQR(100),1.f/SQR(30),1.f/SQR(100),t);
		drawpinmap(tex[0], screenbuf);

		float dt=dofproc()*0.0021;


		FVector *b=blob;
		FVector p;
		for (c1=0;c1<NUMBLOB;c1++,b++)
		{
		#define WARPS 0.5
			*b+=FVector(getwibble( 0,b->X*WARPS)+getwibble(10,b->Y*WARPS)+getwibble(20,b->Z*WARPS),
					   getwibble(30,b->X*WARPS)+getwibble(40,b->Y*WARPS)+getwibble(50,b->Z*WARPS),
					   getwibble(60,b->X*WARPS)+getwibble(70,b->Y*WARPS)+getwibble(80,b->Z*WARPS))*dt;
			float r=sin(b->Z);
			float cx=cos(b->X);
			float sx=sin(b->X);
			p=mycam.axes*(FVector(sx*r*100,sin(b->Y)*cx*r*30,cos(b->Y)*cx*r*100)-mycam.posn);
			if (p.Z>3)
			{
				float f=(10*8)/p.Z;
				int lightx=160+p.X*f;
				int lighty=100+p.Y*f;
				int lightz=4*f;
				int c=f*50;if (c>256) c=256;if (c<64) c=64;
				scalespr(lightx-lightz,lighty-lightz,lightx+lightz,lighty+lightz,screenbuf,64,64,flare,c);
			}

		}

		swapscreens();
	}
	delete [] blob;
	delete [] flare;
}

struct thing
{
	int x1,y1,x2,y2;
	int t;	// type - line, box, arc, dotline, dotarc
	int c;	// colour
	int a1,a2;

	float tm;	// time - 0 to 1 = drawing, after 1 = just sitting...
};

thing *orb;
int numorb;

int calcx(thing *t, float a)
{
	return t->x1+(t->x2-t->x1)/2*(1+cos(a*PI/32));
}

int calcy(thing *t, float a)
{
	return t->y1+(t->y2-t->y1)/2*(1+sin(a*PI/32));
}

void drawthing(thing *t, float ttm)
{
	static thing temp;
	thing *t2=&temp;
	int c1;
	ttm+=t->tm;
	float sh=ttm-int(ttm);
	if (ttm<=0) return;
	if (ttm>=1)
	{

		switch (t->t)
		{
		case 0:
			// line
			line(t->x1,t->y1,t->x2,t->y2);
			break;
		case 3:
			// dotline
			for (c1=0;c1<t->a2;c1++) line(t->x1+float(t->x2-t->x1)/t->a2*(c1+sh),
									  t->y1+float(t->y2-t->y1)/t->a2*(c1+sh),
									  t->x1+float(t->x2-t->x1)/t->a2*(c1+0.5+sh),
									  t->y1+float(t->y2-t->y1)/t->a2*(c1+0.5+sh));
		case 1:
			// box
			if (t->a1) for (c1=0;c1<=t->a1;c1++) line(t->x1+float(t->x2-t->x1)/t->a1*c1,t->y1,t->x1+float(t->x2-t->x1)/t->a1*c1,t->y2);
			if (t->a2) for (c1=0;c1<=t->a2;c1++) line(t->x1,t->y1+float(t->y2-t->y1)/t->a2*c1,t->x2,t->y1+float(t->y2-t->y1)/t->a2*c1);
			break;
		case 2:
			// arc
			for (c1=t->a1*2;c1<t->a2*2+1;c1++) line(calcx(t,c1),calcy(t,c1),calcx(t,c1+1),calcy(t,c1+1));
			break;
		case 4:
			// arc
			sh*=2;
			for (c1=t->a1*2;c1<t->a2*2+1;c1+=2) line(calcx(t,c1+sh),calcy(t,c1+sh),calcx(t,c1+1+sh),calcy(t,c1+1+sh));
			break;
		}
		return;
	}
	// animating
	float zm=1.02/(ttm+0.02);
	float x3=(t->x1+t->x2)*0.5;
	float y3=(t->y1+t->y2)*0.5;
	switch (t->t)
	{
	case 0:
	case 3:
		// line
		if (ttm<0.5)
		{
			#define LSPEED 10
			t2->x1=t->x1+(t->x2-t->x1)*-LSPEED;
			t2->y1=t->y1+(t->y2-t->y1)*-LSPEED;
			t2->x2=t->x1+(t->x2-t->x1)*(-LSPEED+ttm*4*LSPEED);
			t2->y2=t->y1+(t->y2-t->y1)*(-LSPEED+ttm*4*LSPEED);
		}
		else
		{
			t2->x1=t->x1+(t->x2-t->x1)*(-LSPEED+(ttm-0.5)*2*LSPEED);
			t2->y1=t->y1+(t->y2-t->y1)*(-LSPEED+(ttm-0.5)*2*LSPEED);
			t2->x2=t->x1+(t->x2-t->x1)*(LSPEED-(ttm-0.5)*(LSPEED-1));
			t2->y2=t->y1+(t->y2-t->y1)*(LSPEED-(ttm-0.5)*(LSPEED-1));
		}
		if (t->t==0) line(t2->x1,t2->y1,t2->x2,t2->y2);
		else
		for (c1=0;c1<t->a2;c1++) line(t2->x1+float(t2->x2-t2->x1)/t->a2*(c1+sh),
									  t2->y1+float(t2->y2-t2->y1)/t->a2*(c1+sh),
									  t2->x1+float(t2->x2-t2->x1)/t->a2*(c1+0.5+sh),
									  t2->y1+float(t2->y2-t2->y1)/t->a2*(c1+0.5+sh));
		break;
	case 1:
		// box
		t2->x1=x3+(t->x1-x3)*zm;
		t2->y1=y3+(t->y1-y3)*zm;
		t2->x2=x3+(t->x2-x3)*zm;
		t2->y2=y3+(t->y2-y3)*zm;
		//t2->x2=t2->x1+(t2->x2-t2->x1)*ttm;
		//t2->y2=t2->y1+(t2->y2-t2->y1)*ttm;
		if (t->a1) for (c1=0;c1<=t->a1;c1++) line(t2->x1+float(t2->x2-t2->x1)/t->a1*c1,t2->y1,t2->x1+float(t2->x2-t2->x1)/t->a1*c1,t2->y2);
		if (t->a2) for (c1=0;c1<=t->a2;c1++) line(t2->x1,t2->y1+float(t2->y2-t2->y1)/t->a2*c1,t2->x2,t2->y1+float(t2->y2-t2->y1)/t->a2*c1);
		break;
	case 2:
	case 4:
		// arc or dotarc
		if (t->a2-t->a1==32)
		{
			// circle
			t2->x1=x3+(t->x1-x3)*zm;
			t2->y1=y3+(t->y1-y3)*zm;
			t2->x2=x3+(t->x2-x3)*zm;
			t2->y2=y3+(t->y2-y3)*zm;
			sh*=2;
			if (t->t==2) for (c1=t->a1*2;c1<t->a2*2+1;c1++) line(calcx(t2,c1),calcy(t2,c1),calcx(t2,c1+1),calcy(t2,c1+1));
			else for (c1=t->a1*2;c1<t->a2*2+1;c1+=2) line(calcx(t2,c1+sh),calcy(t2,c1+sh),calcx(t2,c1+1+sh),calcy(t2,c1+1+sh));
		}
		else
		{
			// arc
			int a1=t->a1*ttm;
			int a2=t->a2*ttm;
			t2->x1=x3+(t->x1-x3)*ttm;
			t2->y1=y3+(t->y1-y3)*ttm;
			t2->x2=x3+(t->x2-x3)*ttm;
			t2->y2=y3+(t->y2-y3)*ttm;
			if (t->t==2) for (c1=a1*2;c1<a2*2+1;c1++) line(calcx(t2,c1),calcy(t2,c1),calcx(t2,c1+1),calcy(t2,c1+1));
			else for (c1=a1*2;c1<a2*2+1;c1+=2) line(calcx(t2,c1+sh),calcy(t2,c1+sh),calcx(t2,c1+1+sh),calcy(t2,c1+1+sh));
		}
		break;

	}
}

void draworb(float ttm)
{
	for (int c1=0;c1<numorb;c1++) drawthing(orb+c1,ttm);
}

void loadorb(unsigned char *fn)
{
	delete [] orb;
	LFILE *f=openf(fn);
	readf(f,&numorb,4);
	orb=new thing[numorb];
	for (int c1=0;c1<numorb;c1++)
	{
		readf(f,orb+c1,8*4);
		orb[c1].tm=-c1*0.15;
		orb[c1].x1>>=1;orb[c1].y1>>=1;orb[c1].x2>>=1;orb[c1].y2>>=1;
	}
	closef(f);
}

void calcwibblepins(float t,PIN *out, int ymax)
{
	int x,y;
	for (y=0;y<ymax;y++)
	for (x=0;x<41;x++)
	{
		float u=getwibble(11,t+x*0.5)+getwibble(23,t+y*0.4);
		float v=getwibble(64,t*-2.35+x*y*0.008)+getwibble(72,t+(x+y)*0.3);
		out->u=128*256+150*256*getwibble(100,t-8*(u+v));
		out->v=128*256+150*256*getwibble(200,t*1.24+8*(u-v));
		out++;
	}
}

// a=0 is no wibble at all, a=1 is total wibble
void softenpins(float a, int x1, int y1, int x2, int y2, PIN *out, int ymax)
{
	int x,y;
	float a1=1-a;
	x1*=256;x2*=256;
	y1*=256;y2*=256;
	for (y=0;y<ymax;y++)
	{
		float a2=(y1+((y2-y1)*y)/(ymax-1))*a1;
		for (x=0;x<41;x++)
		{
			out->v=(out->v*a)+(x1+((x2-x1)*x)/40)*a1;
			out->u=(out->u*a)+a2;
			out++;
		}
	}
}

void softenpinsold(float a, int x1=0, int y1=0, int x2=256, int y2=256, PIN *out=(PIN*)pin, int ymax=26)
{
	int x,y;
	float a1=1-a;
	x1*=256;x2*=256;
	y1*=256;y2*=256;
	for (y=0;y<ymax;y++)
	{
		float a2=(y1+((y2-y1)*y)/(ymax-1))*a1;
		for (x=0;x<41;x++)
		{
			out->v=(out->u*a)+(x1+((x2-x1)*x)/40)*a1;
			out->u=(out->v*a)+a2;
			out++;
		}
	}
}


void clippins(int x1, int y1, int x2, int y2, PIN *out)
{
	int x,y;
	x1*=256;x2*=256;
	y1*=256;y2*=256;
	for (y=0;y<26;y++)
	{
		for (x=0;x<41;x++)
		{
			if (out->v<x1) out->v=x1;
			if (out->v>x2) out->v=x2;
			if (out->u<y1) out->u=y1;
			if (out->u>y2) out->u=y2;
			out++;
		}
	}
}

void crotocopy(unsigned char *dest, unsigned char *src1, unsigned char *src2)	// src1blurred
{
	static unsigned char mytab[512];
	static unsigned char t=1;
	if (t)
	{
		t=0;int c1,c2=0;
		for (c1=0;c1<512;c1++,c2+=190) {if (c2>255*256) c2=255*256;mytab[c1]=c2>>8;};
	}
	for(int c1=0;c1<64000;c1++)
	{
		*dest=mytab[(src1[0]+src1[1]>>1)+(src2[0]>>1)];
		dest++;src1++;src2++;
	}

}

struct GREET
{
	unsigned char *text;
	FVector p;
	int wid;
	unsigned char *bmap;
};

#define NGREETS 15

char *agrtlist[NGREETS]={"greets","fly","to",
						"acme","tpolm","orange","bomb",
						"cncd","fudge","ribbon","eclipse",
						"all","our","friends"," "};
						
char *bgrtlist[NGREETS]={"greets","fly","to",
						"fudge","fudge","fudge","fudge",
						"fudge","fudge","fudge","fudge",
						"rune","fudge","fudge"," "};

char **grtlist;
GREET grt[NGREETS];
extern int rune;
int rune=0;

void babypart()
{	int c1, x;
	//if (!grtlist)
	{
		if (rune)
		{
			grtlist=bgrtlist;
		}
		else
		{
			grtlist=agrtlist;
		}
	}

	LFILE *f=openf((unsigned char*)"data\\baby.raw");
	readf(f,destpal,768);

	memset(tex[0],0,65536);
	memset(tex[1],0,65536);
	readf(f,tex[0],200*256);
	for (int c1=0;c1<65536;c1++) tex[0][c1]&=127;
	closef(f);

	unsigned char *fontb=new unsigned char[512*FONTHGT];
	memset(fontb,0,512*FONTHGT);
	unsigned char *myfadetab=new unsigned char[16384];
	setblurwid(512);

	for (c1=0;c1<NGREETS;c1++)
	{
		grt[c1].text=(unsigned char*)grtlist[c1];
		grt[c1].wid=strwid(grt[c1].text);
		grt[c1].bmap=new unsigned char[512*FONTHGT];
		memset(grt[c1].bmap,0,512*FONTHGT);
		fontwrite(grt[c1].bmap+256-grt[c1].wid/2,grt[c1].text,512);
		grt[c1].p=FVector(0,0,-c1*3-6);
		grt[c1].p.X=(noisetab2[c1*2+124]-64);
		grt[c1].p.Y=(noisetab2[c1*2+125]-64)/2;

	}

	// load nyna

	f=openf((unsigned char*)"data\\nynaeve.raw");
	unsigned char tmppal[768];
	unsigned char *nyna=new unsigned char[320*240];
	unsigned char *sb=new unsigned char[320*240];
	readf(f,tmppal,768);
	readf(f,nyna,320*240);
	closef(f);
	int *cumpic=new int[320*240];
	makecum(cumpic,nyna,240);

	//



	palpos=0;
	paldest=1;
	palspd=1/300.f;

	float t=39.9;
	dofproc();
	int mode=0;
	float nynaf=1;
	while (!kbhit() && curpos<GREETSEND && nynaf>0)
	{
		unsigned char str[128];sprintf((char*)str,"%f  ",t);monow(0,str);

		// bend the baby
		calcwibblepins(t*3);
		float f=sin(t)*2.5;if (f<-2) f=-2;if (f>2) f=2;
		softenpinsold(f,-64,0,256,200);clippins(10,0,300,230);

		drawpinmapns(tex[0],screenbuf+64000);

		copy320to256(tex[1],screenbuf);
		// bend the old screen
		calcwibblepins(t*2+10);
		softenpinsold(0.3,2,0,266,200);
		drawpinmapns(tex[1],tex[2]);

		rotocopy((unsigned char*)screenbuf,(unsigned char*)tex[2],(unsigned char*)screenbuf+64000);

		unsigned char *dest=(unsigned char*)screenbuf;
		unsigned char *src=(unsigned char*)tex[0]+255;
		for (int y=0;y<200;y++,src+=512)
		{
			for (int x=0;x<256;x++,dest++) *(dest+64000)=cliptab[*dest+(*src-->>1)];
			for (x=0;x<64;x++,dest++) *(dest+64000)=*dest;
		}

		int dt=dofproc();

		GREET *gr=grt;
		for (int c2=0;c2<NGREETS;c2++,gr++)
		{
			// greets speed
			gr->p.Z+=0.06*dt;
			if (gr->p.Z>1 && gr->p.Z<15)
			{
				if (c2&1) gr->p.Z=16-gr->p.Z;
				c1=(gr->p.Z-8)*10.f;
				c1=abs(c1);
				if (c1>=64) c1=63;
				hblur(512,abs(c1)+1,512/4,FONTHGT,(UBYTE*)gr->bmap,(UBYTE*)fontb,(UBYTE*)myfadetab,(65536-(abs(c1)+1)*1000)/(abs(c1)+1),16384);
				float z=10.f/gr->p.Z;
				int x=160+gr->p.X*z;
				int y=100+gr->p.Y*z;
				z*=0.3;
				//if (gr->p.Z>5) z+=(gr->p.Z-5);
				int i=128-gr->p.Z*5;
				if (i>100) i=200-i;
				scalespr(x-z*512,y-z*FONTHGT,x+z*512,y+z*FONTHGT,screenbuf+64000,512,FONTHGT,(UBYTE*)fontb,i);
				if (c2&1) gr->p.Z=16-gr->p.Z;
			}
		}


		t+=1.5*0.0037*dt;

		if (curpos>NYNASTART)
		{
			if (mode==0)
			{
				/*
				unsigned char *d=(unsigned char*)mypal;
				unsigned char *s=(unsigned char*)destpal;
				for (c1=0;c1<128;c1++)
				{
					d[0]=d[3]=s[0];
					d[1]=d[4]=s[1];
					d[2]=d[5]=s[2];
					s+=3;
					d+=6;
				}
				*/
				for (int c1=0;c1<256;c1++) memcpy(mypal[c1],destpal[c1/2],3);

				//memcpy(mypal,destpal,768);
				mode=1;
				memcpy(destpal,tmppal,768);
				palpos=0;

				//palupdate=1;
				//palpos=0;
				paldest=1;
				palspd=0.0001;
			}

			// draw nynaeve
			//memset(sb,0,320*240);

			//float t2=5*(1-cos(t*0.5));
			float t2=7*(1-nynaf);
			float bl=exp(-t2*t2*0.1)*100-1;if (bl<0) bl=0;
			blurcum(sb,cumpic,bl,bl,bl+1.5f,bl+1.5f,256-nynaf*200, 240);




			// fade down the main screen and add it in
			unsigned char *d=sb+20*320;

			c1=nynaf*255;
			palpos=1-nynaf;
			nynaf-=0.0055*dt;
			if (nynaf<0) nynaf=0;

			if (1)	// var fix
			{
				unsigned char *l=(unsigned char*)multab+256*c1;
				unsigned char *s=(unsigned char*)screenbuf+64000;
				unsigned char *d=sb+320*20;
				for (c1=0;c1<320*200;c1++,d++) *d=cliptab[l[*s++]+*d];
			}

			swapscreens2(sb);
			palupdate=1;

		}
		else
		{
			swapscreens(screenbuf+64000);
		}
	}

	// nyna eve splits up

	float t2=7*(1-nynaf);
	float bl=exp(-t2*t2*0.105)*120-1.5;if (bl<0.5) bl=0;
	blurcum(sb,cumpic,bl,bl,bl+1.5f,bl+1.5f,256-nynaf*200, 240);
	memcpy(mypal,tmppal,768);
	memcpy(destpal,tmppal,768);
	palpos=0;palupdate=1;
	nynaf=0;
	palspd=0;
	swapscreens2(nyna);
	//while (((volatile)curpos)<NYNAEND-32 && !kbhit()){	curpos++;curpos--; }
	while (!kbhit() && curpos<NYNAEND && nynaf<1)
	{
		int dt=dofproc();
		if (curpos>NYNAEND-32)
		{
			nynaf+=0.0065*dt;
			if (nynaf>1) nynaf=1;
			palspd=0;
			setpalcol(5,10,15);
			palpos=nynaf*1.2;
			if (palpos>1) palpos=1;
			palupdate=1;
		}
		float t2=7*(1-nynaf);
		float bl=exp(-t2*t2*0.1)*100-1;if (bl<0) bl=0;
		blurcum(sb,cumpic,bl,bl,bl+1.5f,bl+1.5f,256-nynaf*200, 240);
		swapscreens2(sb);
		palupdate=1;
	}

	delete [] cumpic;
	delete [] nyna;
	delete [] sb;

	delete [] fontb;
	delete [] myfadetab;
	for (c1=0;c1<NGREETS;c1++) delete [] grt[c1].bmap;




	memset(screenbuf,0,320*240);
	swapscreens2();
	swapscreens2();

}

void whitepal()
{
	memset(mypal,255,768);
	setpal(mypal);
}

float moos=0;

void tfproc()
{
	moos*=0.8;
	if ((rand()&255)<5) moos+=fabs(frand(0.5));
}

void xcopy(int yofs, unsigned char *src, int numy)
{
	memcpy(wina000[yofs],src,320*numy);
	CopyPal2Screen((unsigned char*)wina000,numy>240?480:240);
}

void title()
{
	int c1,c2;
	LFILE *f;
	f=openf((unsigned char*)"data\\compo2.raw");
	readf(f,mypal[128],384);
	readf(f,mypal[0],384);
	readf(f,tex[1],320*480);
	//for (c1=0;c1<320*480;c1++) tex[1][c1]=(tex[1][c1]>>1);
	closef(f);
	f=openf((unsigned char*)"data\\sqre.raw");
	memset(tex[4],0,65536);
	unsigned char *sqre=(unsigned char*)tex[4]+8192;
	readf(f,sqre,320*128);
	for (c1=0;c1<320*128;c1++) tex[4][c1]=(tex[4][c1]>>1);
	closef(f);

	f=openf((unsigned char*)"data\\sunflare.raw");
	readf(f,tex[0],65536);
	for (c1=0;c1<65536;c1++)
	{
		tex[0][c1]>>=1;
		if (SQR((c1&255)-128)+SQR((c1>>8)-128)>128*128) tex[0][c1]=0;
	}
	closef(f);

	fixpal((unsigned char*)"data\\debut.pal");


	//for (c1=128;c1<256;c1++) mypal[c1][0]=mypal[c1][1]=mypal[c1][2]=(c1-128)/2;
	setpal(mypal);
	float t=0;
	float morph=1.5;
	tweak(1,1);
	unsigned char *out,*in;

	//computeghost("data\\title.gst",32,32);
	readghost((unsigned char*)"data\\title.gst");




	dofproc();

	out=(unsigned char*)screenbuf;


	unsigned char *b1=(unsigned char*)new unsigned char[320*250];
	unsigned char *b2=(unsigned char*)new unsigned char[320*250];
	memset(b1,0,320*250);b1+=320;
	memset(b2,0,320*250);b2+=320;

	int lx,ly,lz2;
	lx=200;
	ly=50;
	lz2=150;
	t=0;


	int ms=0;

	addfproc(tfproc);

	float t2=0;
	while (!kbhit() && curpos<60)
	{

		c1=1-t*10;if (c1<0) c1=0;
		if (c1>127) c1=128;

		if (curpos/8!=ms)
		{
			ms=curpos/8;
			moos+=0.5;
			t=0;
			lx=abs(rand())%320;
			ly=abs(rand())%200;
		}

		int dt=dofproc();
		t=t+0.1*dt;
		if (curpos>60-16) t2+=dt*0.85;
		if (t<1)
		{
			int lz2=150+t*250;
			float t2=t;if (t2>0.5) t2=1-t;
			scalespr(lx-lz2,ly-lz2,lx+lz2,ly+lz2,b1,256,256,tex[0],t2*405);
		}

		unsigned char *s=(unsigned char*)tex[1];
		unsigned char *d=(unsigned char*)screenbuf;
		unsigned char *l=(unsigned char*)b1;

		int x,y;
		for (y=0;y<480;y++)
		{
			if (y&1) l-=320;
			unsigned char *r=&noisetab[rand()&511];
			for (x=0;x<320;x++)
			{

				*d++=multab[(*l+++(*r++<<2)<<8)+*s++];

			}
		}

		s=(unsigned char*)multab+125*256;
		l=(unsigned char*)b1;
		d=(unsigned char*)b2;

		for (c1=0;c1<320*240;c1++)
		{
			*d++=s[(l[-1]+l[1]+l[-320]+l[320])/4];
			l++;
		}
		s=(unsigned char*)b1;
		b1=b2;
		b2=s;

		c1=moos*100+t2;
		if (c1>128) c1=128;
		if (c1<0) c1=0;
		xfade(screenbuf,tex[1],128-c1,c1);


		//tex[3][rand()&65535L]=127;

		swapscreens3(out);

	}
	b1-=320;
	b2-=320;
	delete []b1;
	delete [] b2;

	removefproc(tfproc);
	if (kbhit()) return;

	int *cumpic=new int[320*480];
	makecum(cumpic,tex[1],480);

	for (c1=0;c1<320*480;c1++) tex[1][c1]|=128;
	memcpy(screenbuf,tex[1],320*480);
	out=(unsigned char*)screenbuf+176*320;
	in=(unsigned char*)tex[1]+176*320;


	unsigned char *blur1=new unsigned char[130*320];memset(blur1,0,130*320);blur1+=320;
	unsigned char *blur2=new unsigned char[130*320];memset(blur2,0,130*320);blur2+=320;

	//WIN32DONE
	xcopy(0,(unsigned char*)(tex[1]),480);
	unsigned char mclip[512];
	for (c1=0;c1<512;c1++) mclip[c1]=(c1>256)?c1-256:0;
	unsigned char *myfadetab=new unsigned char[16384];
	setblurwid(320);

	t=0;
	float ft=0;
	float tt=0;
	int mode=0;
	dofproc();
	while (!kbhit() && mode<2)
	{

		// blur the picture
		if (mode)
		{
			int c1,c2,c3;
			c2=tt*15.2-256;
			for (c1=0;c1<256;c1++) {c3=c1+c2;if (c3<0) c3=0;if (c3>255) c3=255;mclip[c1]=c3/2;}
			unsigned char *s=(unsigned char*)tex[1];
			unsigned char *d=(unsigned char*)tex[0];
			for (c1=0;c1<65536;c1++,s++,d++) *d=mclip[*s];
			calcwibblepins(t*0.053,(PIN*)pin,31);
			//softenpins(1,0,0,256,256,(PIN*)pin,31);
			drawpinmap48(tex[0],screenbuf);
			if (curpos>=64*2) mode=2;
		}
		else
		{
			float t2=6-ft*sqrt(ft)*0.002151;if (t2<0) t2=0;
			float bl=exp(-t2*t2*0.11)*120-2;if (bl<0.5) bl=0;
			if (bl>0)
			{
				blurcum(screenbuf,cumpic,bl+1.5f,bl*2+1.f,bl,bl*2,256-bl*7, 480);
				for (int *dd=(int*)screenbuf,c1=0;c1<320*480/4;c1++,dd++) *dd|=0x80808080;
			} else memcpy(screenbuf,tex[1],480*320);
			if (curpos>64+48) {
				tt=0;
				mode=1;
				LFILE *f=openf((unsigned char*)"data\\plasma.raw");
				readf(f,tex[1],256*256);
				closef(f);
				dofproc();
			}
		}

		// blur the logo
		c1=64-t;
		if (c1<0) c1=0;
		if (c1>=64) c1=63;
		float f=1-c1/64.f;
		hblur(320,abs(c1)+1,320/4,128,(UBYTE*)sqre,(UBYTE*)tex[5],(UBYTE*)myfadetab,f*(65536-(abs(c1)+1)*1000)/(abs(c1)+1),16384);

		// copy the logo in and blur it
		unsigned char *s=blur1;
		unsigned char *d=blur2;
		unsigned char *l=(unsigned char*)tex[5];
		blur1=d;
		blur2=s;
		for (c1=0;c1<320*128;c1++)
		{
			*d++=cliptab[((s[-2]+s[2]+s[-320]+s[-1]+s[0]+s[1]+s[320])>>3)+*l++];
			s++;
		}
		d=out;
		s=blur1;
		l=(unsigned char*)sqre;
		for (c1=0;c1<320*128;c1++)
		{
			*d=ghostptr[mclip[(*s>>1)-*l+256]+(*d<<8)];
			d++;s++;l++;
		}


		//xcopy((unsigned char*)0xa0000+176*320/4,out,128);
		swapscreens3();

		int dt=dofproc();
		// fade speed
		t+=dt*0.22;
		// blur speed
		if (curpos>64+16) ft+=dt*0.32;
		// burn out speed
		tt+=dt*0.30;


	}

	blur1-=320;delete [] blur1;
	blur2-=320;delete [] blur2;
	delete [] myfadetab;
	delete [] cumpic;
	if (kbhit()) return;
	whitepal();
	tweak(0,0);
	memset(screenbuf,255,64000);
	swapscreens();
}