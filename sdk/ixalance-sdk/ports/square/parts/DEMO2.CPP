#include "stdafx.h"
#include "common.h"

#define MINZ 1.4f
#define SCALE 200.f



void ybars(void *dst)
{
	unsigned char *dest=(unsigned char*)dst;
	static unsigned char o[200];
	int c1,c2,c3,c4;


	#define SC 2
	#define NUMYBAR 40
	static int y[NUMYBAR];
	static int dy[NUMYBAR];
	static int s[NUMYBAR];
	static int f=1;
	if (f)
	{
		f=0;
		for (c1=0;c1<NUMYBAR;c1++)
		{
			y[c1]=((rand()&255)-20)<<SC;
			dy[c1]=((rand()&255)-20)<<SC;
			s[c1]=(rand()&7)+2;
		}
	}
	if (!dest)
	{
		for (c1=0;c1<NUMYBAR;c1++)
		{
			if (y[c1]>dy[c1]) y[c1]-=s[c1]; else
			if (y[c1]<dy[c1]) y[c1]+=s[c1];
			if (abs(dy[c1]-y[c1])<5) dy[c1]=((rand()&255)-20)<<SC;
		}
		return;
	}
	memset(o,1,200);

	for (c1=0;c1<NUMYBAR;c1++)
	{
		c2=y[c1]>>SC;
		c3=((dy[c1]&255)%5)+1;
		c4=0;
		if (c1==10 || c1==11) c4=2;
		if ((c1&7)==0) c4=1;
		while (c3--)
		{
			if (c2>=0 && c2<200) o[c2]=c4;
			c2++;
		}
	}

	c2=1;

	for (c1=0;c1<200;c1++)
	{
		memset(dest,o[c1]*50,320);
		dest+=320;
	}
}

void ybarsfproc()
{
	ybars(NULL);
}

int fatlx=160;
int fatly=100;

void fatline(FVector a, FVector b, float fat, int col)
{
	if (a.Z<MINZ || b.Z<MINZ) return;
	float f1=SCALE/a.Z;
	float f2=SCALE/b.Z;
	a.X=a.X*f1+fatlx;a.Y=a.Y*f1+fatly;
	b.X=b.X*f2+fatlx;b.Y=b.Y*f2+fatly;
	FVector d=b-a;
	d.Normalise();
	f1*=fat;
	f2*=fat;
	int q[4][2]={a.X-d.Y*f1,a.Y+d.X*f1,
				 a.X+d.Y*f1,a.Y-d.X*f1,
				 b.X+d.Y*f2,b.Y-d.X*f2,
				 b.X-d.Y*f2,b.Y+d.X*f2};
	flatquad(screenbuf,q,col);
}

void circle(int x, int y, float fr, int col)
{
	int r=fr+0.5;
	int yy;
	int y1=y-r;
	int y2=y+r;
	if (y1>=200 || y2<0 || x+r<0 || x-r>=320) return;
	if (y1<0) miny=0; else miny=y1;
	if (y2>200-1) maxy=200; else maxy=y2+1;
	float rr=fr*fr;
	for (yy=-r;yy<=0;yy++)
	{
		int tp=!(y1<0 || y1>=200);
		int bt=!(y2<0 || y2>=200 || yy==0);
		if (tp|bt)
		{
			int x1=sqrt(fabs(rr-yy*yy));
			int x2=x+x1;
			x1=x-x1;
			if (x2>320) x2=320;if (x2<0) x2=0;
			if (x1>320) x1=320;if (x1<0) x1=0;
			if (tp) {edgebuf[y1][0]=x1<<16;edgebuf[y1][1]=x2<<16;}
			if (bt) {edgebuf[y2][0]=x1<<16;edgebuf[y2][1]=x2<<16;}
		}
		y1++;y2--;
	}
	flatfill(screenbuf,col);
}


MOL *readmol(unsigned char *name)
{
	LFILE *f=openf(name);
	MOL *m=new MOL;
	readf(f,m,8+2*12);
	m->a=new _ATOM[m->numa];
	m->b=new BOND[m->numb];
	for (int c1=0;c1<m->numa;c1++)
	{
		readf(f,&m->a[c1],20);
		m->a[c1].s=1;
	}
	readf(f,m->b,m->numb*8);
	closef(f);
	m->axes.MakeID();
	m->posn=FVector(0,0,0);
	return m;

}

MOL *copymol(MOL *s)
{
	MOL *m=new MOL;
	memcpy(m,s,sizeof(MOL));
	m->a=new _ATOM[m->numa];
	m->b=new BOND[m->numb];
	memcpy(m->a,s->a,sizeof(_ATOM)*m->numa);
	memcpy(m->b,s->b,sizeof(BOND)*m->numb);
	return m;
}

float frand(float f)
{
	return ((rand()-16384)*f)*(1.f/16384.0f);
}

float getwibble(int i,float t )
{
	float f=0;
	float a=0.005;
	float ff=0.001f;
	for (int c1=0;c1<3;c1++)
	{
		f+=a*float(noisetab2[i++]+64)*sin(float(noisetab2[i++]-64)+float(noisetab2[i++]+64)*ff*t);
		a*=0.5;
		ff*=2;
	}
	return f;
}

void makestarpos(MOL *m,float t)
{
	int c1;

	_ATOM *a=m->a;
	a->p=FVector(0,0,0);
	a->s=2;

	float theta=getwibble(23,t)/2;
	for (c1=1;c1<m->numa;c1++)
	{
		float r=(1.7+getwibble(5*c1,t))*2;
		theta+=(PI*2/(m->numa-1));
		a++;
		a->s=1;
		a->p=FVector(sin(theta)*r,cos(theta)*r,0);
	}
}

MOL *makestarmol()
{
	MOL *m=new MOL;
	m->numa=8;
	m->numb=m->numa-1;
	m->min=FVector(-1,-1,0);
	m->max=FVector(1,1,0);
	m->a=new _ATOM[m->numa];
	m->b=new BOND[m->numb];
	for (int c1=0;c1<m->numb;c1++)
	{
		((m->b[c1]))[0]=c1+1;
		((m->b[c1]))[1]=0;
	}
	m->axes.MakeID();
	m->posn=FVector(0,0,0);
	makestarpos(m,0);
	return m;
}

void rotatemol(MOL *m, CAM *c, float sc)
{
	_ATOM *a=m->a;
	int c1;
	FMatrix m2=c->axes*m->axes;
	FVector cc=c->axes*(m->posn-c->posn);
	for (c1=0;c1<m->numa;c1++,a++)
	{
		a->rp=(m2*a->p)+cc;
		if (a->rp.Z>MINZ)
		{
			float f=SCALE/a->rp.Z;
			a->pf=f;
			a->px=160+f*a->rp.X;
			a->py=100+f*a->rp.Y;

		} else a->px=a->py=0;
	}
}

void drawmol(MOL *m)
{
	BOND *b=m->b;
	_ATOM *a=m->a;
	for (int c1=0;c1<m->numb-1;c1++,b++)
	{
		if (a[*b[0]].rp.Z>MINZ*3 && a[*b[1]].rp.Z>MINZ*3)
		{
			linecol=36;
			line(a[(*b)[0]].px,a[(*b)[0]].py,
				 a[(*b)[1]].px,a[(*b)[1]].py);
			linecol=30;
			line(480-a[(*b)[0]].px*2,a[(*b)[0]].py*3/2-50,
				 480-a[(*b)[1]].px*2,a[(*b)[1]].py*3/2-50);
		}
	}
}

void drawmol2(MOL *m, int cc1,int cc2,float sf1, float sf2,int x1, int y1)
{

	BOND *b=m->b;
	_ATOM *a=m->a;
	fatlx=160+x1;
	fatly=100+y1;
	for (int c1=0;c1<m->numb-1;c1++,b++)
	{
		fatline(a[(*b)[0]].rp,a[(*b)[1]].rp,sf1,cc1);
		/*
		if (a[*b[0]].rp.Z>MINZ && a[*b[1]].rp.Z>MINZ)
			line(a[(*b)[0]].px,a[(*b)[0]].py,
				 a[(*b)[1]].px,a[(*b)[1]].py);
				 */
	}
	for (int c1=0;c1<m->numa;c1++,a++)
	{
		if (a->rp.Z>MINZ)
		{
			circle(x1+a->px,y1+a->py,a->pf*a->s*sf2,cc2);
		}

	}


}

#define NUMTUB 15

FVector molc[NUMTUB];
FMatrix mola[NUMTUB];
FMatrix molva[NUMTUB];
float molv[NUMTUB];

void tubfproc()
{
	FMatrix m1,m2,m3;
	for (int c1=0;c1<NUMTUB;c1++)
	{
		molc[c1].Y-=molv[c1];
		if (molc[c1].Y<-20)
		{
			molc[c1]=FVector(frand(15),frand(10),frand(15));
			m1.MakeXRot(frand(5));
			m2.MakeYRot(frand(5));
			m3.MakeXRot(frand(5));
			mola[c1]=m1*m2*m3;
			m1.MakeXRot(frand(0.01));
			m2.MakeYRot(frand(0.01));
			m3.MakeXRot(frand(0.01));
			molva[c1]=m1*m2*m3;
			molv[c1]=frand(0.01)+0.03;
			molc[c1].Y=20;
		}
		mola[c1]=mola[c1]*molva[c1];
	}
}

void tub()
{
	int c1;
	unsigned char *names[]={(unsigned char*)"data\\c6h12o5.mol",(unsigned char*)"data\\caffeine.mol",(unsigned char*)"data\\ecstasy.mol",(unsigned char*)"data\\dna.mol"};

	loadraw((unsigned char*)"data\\stonedf.raw",tex[0]);
	int greencol=tex[0][290];

	mypal[254][0]= 6*0.7;
	mypal[254][1]=25*0.7;
	mypal[254][2]=12*0.7;

	mypal[255][0]= 4*0.7;
	mypal[255][1]=20*0.7;
	mypal[255][2]= 9*0.7;






	MOL *m[NUMTUB];
	for (c1=0;c1<3;c1++)
	{
		m[c1]=readmol(names[c1]);
	}
	m[c1]=makestarmol();
	for (;c1<NUMTUB;c1++)
	{
		m[c1]=copymol(m[c1%4]);
	}

	CAM mycam;
	mycam.posn=FVector(0,0,-40);
	mycam.axes.MakeID();
	float theta=0;

	FMatrix m1,m2,m3;
	for (c1=0;c1<NUMTUB;c1++)
	{
		molc[c1]=FVector(frand(15),frand(20),frand(15));
		m1.MakeXRot(frand(5));
		m2.MakeYRot(frand(5));
		m3.MakeXRot(frand(5));
		mola[c1]=m1*m2*m3;
		molv[c1]=frand(0.01)+0.03;
		m1.MakeXRot(frand(0.01));
		m2.MakeYRot(frand(0.01));
		m3.MakeXRot(frand(0.01));
		molva[c1]=m1*m2*m3;
	}
	addfproc(tubfproc);


	setpalblack();
	palpos=1;
	paldest=0;
	palspd=1/100.f;
	int mode=0;

	while (!kbhit() && curpos < STONEDEND)
	{
		if (curpos>STONEDEND-16 && mode==0)
		{
			setpalgrey();
			palpos=0;
			palspd=1/40.f;
			paldest=1;
			mode=1;
		}
		if (curpos>STONEDEND-8 && mode==1)
		{
			memcpy(mypal,destpal,768);
			setpalblack();
			palpos=0;
			paldest=1;
			mode=2;
		}

		memset(screenbuf,greencol,64000);
		int dt=dofproc();
		theta+=0.3*dt;
		m1.MakeXRot(0.2*getwibble(11,theta*0.2));
		mycam.axes.MakeYRot(theta*0.018);
		mycam.axes=m1*mycam.axes;
		mycam.posn=mycam.axes.Row[2]*-25;

		for (c1=0;c1<NUMTUB;c1++)
		{
			if ((c1&3)==3) makestarpos(m[c1],c1*4+theta*0.5);
			m[c1]->posn=molc[c1]+FVector(2*getwibble(c1*8,theta*0.3),2*getwibble(c1*8+11,theta*0.3),2*getwibble(c1*8+45,theta*0.3));
			m[c1]->axes=mola[c1];
			rotatemol(m[c1],&mycam);
			drawmol2(m[c1],  0,  0, 0.25,0.7);
		}
		for (c1=0;c1<NUMTUB;c1++)
		{
			drawmol2(m[c1], 255,254, 0.10,0.4);
		}

		{
			unsigned char *s=(unsigned char*)tex[0];
			unsigned char *d=(unsigned char*)screenbuf;
			for (c1=0;c1<64000;c1++,s++,d++) if (*s!=greencol) *d=*s;
		}

		swapscreens(screenbuf);
	}
	removefproc(tubfproc);

	for (c1=0;c1<NUMTUB;c1++)
	{
		delete m[c1];
	}

}


void molpart()
{
	tub();
	unsigned char *names[]={(unsigned char*)"data\\c6h12o5.mol",(unsigned char*)"data\\caffeine.mol",(unsigned char*)"data\\ecstasy.mol",(unsigned char*)"data\\dna.mol"};
	for (int dodo=0;dodo<4;dodo++)
	{
	MOL *m=readmol(names[dodo]);
	CAM mycam;
	mycam.posn=FVector(0,0,-40);
	mycam.axes.MakeID();

	float theta=0;

	GetMouseV();
	addfproc(ybarsfproc);

	float starpos=0;
	if (dodo==1) m=makestarmol();

	while (!kbhit())
	{
		int dt=dofproc();

		starpos+=dt*0.1f;

		if (dodo==1) makestarpos(m,starpos);



		GetMouseV();
		GetMouse();
		FMatrix h;h.MakeYRot(mxv/1000.0f);
		FMatrix g;g.MakeXRot(myv/1000.0f);
		mycam.axes=(g*h)*mycam.axes;
		if (mb==1) 	mycam.posn=mycam.posn+mycam.axes.Row[2]*0.25;
		if (mb==2) 	mycam.posn=mycam.posn-mycam.axes.Row[2]*0.25;

		//memset(screenbuf,40,64000);
		ybars(screenbuf);

		m->axes.MakeZRot(theta);theta+=0.01;


		rotatemol(m,&mycam);
		//drawmol2(m,  0,  0, 0.25,0.7);drawmol2(m, 80,100, 0.10,0.4);

		drawmol2(m,  0,  0, 0.50,1.0);
		drawmol2(m,255,255, 0.40,0.9);
		drawmol2(m, 50, 50, 0.30,0.8);

		swapscreens(screenbuf);
	}

	removefproc(ybarsfproc);

	delete m;
	getch();
	}
}