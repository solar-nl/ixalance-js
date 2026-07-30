#include "stdafx.h"
#include "common.h"

struct BRNP
{
	FVector p;
	FVector n;
	int c;
	int px,py,pz;
} *brnp;

struct BRNT
{
	BRNP *a,*b,*c;
	int sm;
	FVector n;
	BRNT *next;
} *brnt;

struct BRNL
{
	BRNP *a,*b;
};

BRNL *brnl;

int numbp,numbt,numbl;
BRNT **brnb;
#define MAXBUK 128



void loadraw(unsigned char *fname, void *dest, int w,int h, int nc, int fc, int sh)
{
	int c1;
	LFILE *f=openf(fname);
	readf(f,&mypal[fc][0],nc*3);
	readf(f,dest,w*h);
	w=w*h;
	unsigned char *b=(unsigned char*)dest;
	if (sh) for (c1=0;c1<w;c1++,b++) *b>>=sh;
	b=(unsigned char*)dest;
	if (fc) for (c1=0;c1<w;c1++,b++) *b+=fc;
	closef(f);
}

void secretpart()
{
	int c1,c2;
	loadraw((unsigned char*)"data\\secret.raw",tex[0],320,240);
	loadraw((unsigned char*)"data\\zebou.raw",tex[2],320,240);
	unsigned char tmppal[256][3];
	memcpy(tmppal,mypal,768);
	setpal(mypal);
	float theta=0;
	while (!kbhit())
	{

		memcpy(screenbuf,tex[2],76800);
		if ((curpos&7)<4)
		{
			for (c1=0;c1<76800;c1++) if (tex[0][c1]!=255) screenbuf[c1]=tex[0][c1];
		}

		int dt=dofproc();
		theta+=dt*0.011;
		{
		//////////
		float t=theta*1.2;
		float f=sin(t*5+frand(0.0))*0.4+0.6;

		for (c1=0;c1<256;c1++)
		for (c2=0;c2<3;c2++)
		{
			int c0=tmppal[c1][c2]*f;

			if (c0<0) c0=0;
			if (c0>63) c0=63;
			//if (palrev) c0^=63;
			mypal[c1][c2]=c0;
			palpos=0;
		}
		palupdate=1;
		//////////
		}

		swapscreens2(screenbuf);
	}
}

void dnapart()
{
	int c1;

	setpalwhite();
	palpos=1;
	paldest=0.999;
	palspd=1/200.f;

	loadraw((unsigned char*)"data\\fond2.raw",tex[0]);
	//computefade("data\\dna.fad");
	readfade((unsigned char*)"data\\dna.fad");
	MOL *m=readmol((unsigned char*)"data\\dna.mol");
	CAM mycam;
	mycam.axes.MakeID();
	float theta=0;
	int mp=curpos/1;

	addfproc(ynoisefproc);

	paldest=0;

	int anipos=0;
	int anifr=0;
	// open the ani
	LFILE *anif=openflzw((unsigned char*)"data\\zebou.lzw");
	unsigned char *anibuf=new unsigned char[64000];

	int sx=0;
	int sy=0;

	while (!kbhit() && curpos<DNAEND)
	{
		int dt=dofproc();
		theta+=dt*0.04;

		if (curpos/32!=mp)
		{
			mp=curpos/32;
			setpalrev(16);
			//theta+=1;
		}

		mycam.posn=FVector(getwibble(11,theta)*40,getwibble(21,theta)*40,getwibble(31,theta)*20);
		//mycam.posn.Normalise();	mycam.posn=mycam.posn*30;
		float theta2=theta-11;
		FVector posn=FVector(getwibble(11,theta2)*10,getwibble(21,theta2)*10,getwibble(31,theta2)*10);
		mycam.axes.Row[2]=posn-mycam.posn;
		mycam.axes.Normalise();

		m->axes.MakeZRot(theta*0.3);


		memcpy(screenbuf,tex[0],64000);



		if (curpos!=anipos)
		{

			static int hlf=0;
			if (anifr<68)
			{
				readf(anif,anibuf,800);
				readf(anif,anibuf,64000);
				anifr++;
			}
			hlf=!hlf;
			anipos=curpos;
			sx=rand()%5;
			sy=rand()%5;

		}
		unsigned char *s=anibuf;
		unsigned char *d=(unsigned char*)screenbuf+sx+sy*320;
		for (c1=0;c1<64000;c1++,s++,d++) if (*s) *d=85;


		rotatemol(m,&mycam);
		//drawmol2(m,  0,  0, 0.25,0.7);
		drawmol(m);

		calcynoise(ycols,34,5,-6);noisefade(screenbuf,ycols,rand());






		swapscreens();
	}
	closef(anif);

	delete [] anibuf;
	removefproc(ynoisefproc);


	delete m;
}

void loadbrain()
{
	int c1;
	LFILE *f=openf((unsigned char*)"data\\braino2.dat");
	readf(f,&numbp,4);brnp=new BRNP[numbp];
	readf(f,&numbt,4);brnt=new BRNT[numbt];
	readf(f,&numbl,4);brnl=new BRNL[numbl];

	for (c1=0;c1<numbp;c1++)
	{
		readf(f,&brnp[c1].p.X,4);
		readf(f,&brnp[c1].p.Z,4);
		readf(f,&brnp[c1].p.Y,4);brnp[c1].p.Y=-brnp[c1].p.Y;
		brnp[c1].n=FVector(0,0,0);
	}
	for (c1=0;c1<numbt;c1++)
	{
		readf(f,brnt+c1,16);
		brnt[c1].a=brnp+((int)brnt[c1].a);
		brnt[c1].b=brnp+((int)brnt[c1].b);
		brnt[c1].c=brnp+((int)brnt[c1].c);
		FVector a=brnt[c1].a->p-brnt[c1].b->p;
		FVector b=brnt[c1].c->p-brnt[c1].b->p;
		a=a^b;a.Normalise();
		brnt[c1].n=a;
		brnt[c1].a->n+=a;
		brnt[c1].b->n+=a;
		brnt[c1].c->n+=a;
	}
	readf(f,brnl,8*numbl);
	for (c1=0;c1<numbl;c1++)
	{
		brnl[c1].a=brnp+((int)brnl[c1].a);
		brnl[c1].b=brnp+((int)brnl[c1].b);
	}
	closef(f);
	for (c1=0;c1<numbp;c1++)
	{
		brnp[c1].n.Normalise();
		brnp[c1].c=64+64*(FVector(0.2,0.7,-0.4)*brnp[c1].n);
	}
}

int lc=0;
int lcx=160;
int lcy=100;

void oline(int x1,int y1, int x2, int y2)
{
	linecol=lc/2;
	if (!linecol) return;
	x1=160-(x1-lcx)*(0.01*(lc+64));
	x2=160-(x2-lcx)*(0.01*(lc+64));
	y1=100-(y1-lcy)*(0.01*(lc+64));
	y2=100-(y2-lcy)*(0.01*(lc+64));

	line(x1,y1,x2,y2);

}


void brainpart(int end)
{
	CAM mycam;
	CAM *cam=&mycam;
	int c1,c2;
	float theta=0;
	float theta2=0;

	static int secondtime=-1;
	secondtime++;

	setpalwhite(10000);

	loadbrain();
	brnb=new BRNT*[MAXBUK];
	memset(brnb,0,MAXBUK*4);

	unsigned char tmppal[256][3];
	loadraw((unsigned char*)"data\\senseof.raw",tex[0]);
	memcpy(mypal[128],mypal[0],384);

	for (c1=0;c1<65536;c1++) tex[0][c1]=(tex[0][c1]*2);

	for (c1=0;c1<128;c1++)
	{
		mypal[c1][0]=c1*0.5;
		mypal[c1][1]=c1*0.45;
		mypal[c1][2]=c1*0.4;
	}
	memcpy(tmppal,mypal,768);
	memcpy(destpal,mypal,768);



	//computefade("data\\brain.fad");
	readfade((unsigned char*)"data\\brain.fad");

	setpalwhite(50);

	dofproc();
	int cp=0;
	int quit=0;
	float foobar=1;
	int doti=0;
	while (!quit)
	{

		//if (fxkeys()==27) quit=1;

				//unsigned char str[256];
				//sprintf(str,"combfbk=%4.2f data=%4.2f comb=%4.2f delay=%4.2f ",CFEEDBACK,DATAMIX,COMBMIX,DELAYMIX);
				//monow(20*160,str);

		memset(screenbuf,0,64000);


		{
		//////////
		float t=theta*0.1;
		float f=sin(t*5)*0.4+0.6;
		if ((cp&7)==0) f+=1;
		//if ((rand()&255)<8) f+=1;
		//if ((rand()&255)<4) f+=0.5;
		if (palrev) f+=fabs(frand(2));

		for (c1=0;c1<256;c1++)
		for (c2=0;c2<3;c2++)
		{
			int c0=tmppal[c1][c2]*f;

			if (c0<0) c0=0;
			if (c0>63) c0=63;
			//if (palrev) c0^=63;
			mypal[c1][c2]=c0;
			palpos=0;
		}
		palupdate=1;
		//////////
		}

		if (curpos>=DOTTED)
		{
			int i=(curpos-DOTTED)/3;
			if (i!=doti)
			{
				doti=i;
				palrev=0;
				palupdate=1;
				setpalblack();
				palpos=-foobar;
				foobar*=0.85;
				paldest=1;
				palspd=1/5.f;
			}
			if (curpos>=TVSTART)
			{
				palpos=1.00001;
				paldest=1;
				setpalblack(1000);
				memset(mypal,0,768);
				palupdate=1;
			}
		}


		int dt=dofproc();
		theta+=dt*0.11;
		theta2+=dt*0.05;

		lc-=dt;
		if (lc<0) lc=0;
		if (curpos/32!=cp)
		{
			cp=curpos/32;
			lc=200;
			lcx=frand(64)+160;
			lcy=frand(32)+100;
			if (curpos<DOTTED)
			{
				palrev=!palrev;
				setpalrev(20);
			}
			else
			{
				palrev=0;
			}
			theta2=frand(240);
		}



		// new orient
		mycam.posn=FVector(getwibble(11,theta),getwibble(21,theta),getwibble(31,theta));
		mycam.posn.Normalise();	mycam.posn=mycam.posn*4.5;
		float thet2=theta-11;
		FVector posn=FVector(getwibble(11,thet2)*2,getwibble(21,thet2)*2,getwibble(31,thet2)*2);
		mycam.axes.Row[2]=posn-mycam.posn;
		mycam.axes.Normalise();

		float f;
		BRNP *p=brnp;
		FVector rp;
		FVector light(getwibble(23,theta*11/10),getwibble(33,theta*11/10),getwibble(66,theta*17/10));
		light.Normalise();


		#define MINZ 0.5

		for (c1=0;c1<numbp;c1++,p++)
		{
			rp=cam->axes*(p->p-cam->posn);
			#define SCALE 70
			if (rp.Z<MINZ) p->c=0; else
			{
				f=SCALE/rp.Z;
				p->c=100*(light*p->n);
				if (p->c<5) p->c=5;
				p->pz=int(rp.Z*5);
				p->px=160+f*rp.X;
				p->py=100+f*rp.Y;
			}
		}


		BRNT *t=brnt;
		for (c1=0;c1<numbt;c1++,t++)
		{
			if (t->a->c!=0 && t->b->c!=0 && t->c->c!=0)
			{
				c2=t->a->pz+t->b->pz+t->c->pz;
				if (c2>0)
				{
					if (c2>=MAXBUK) c2=MAXBUK-1;
					t->next=brnb[c2];
					brnb[c2]=t;
				}
			}
		}
		for (c1=MAXBUK-1;c1>=0;c1--)
		{
			t=brnb[c1];
			while (t)
			{
				int vv[]={t->c->px,t->c->py,t->b->px,t->b->py,t->a->px,t->a->py};
				int ss[]={t->c->c,t->b->c,t->a->c};
				if (flattri(0,vv,0)>0)
				{
					gouraudfill(screenbuf,ss,vv);
				}
				t=t->next;
			}
			brnb[c1]=0;
		}



		/*
		// new orient
		mycam.posn=FVector(getwibble(11,theta2)*4,getwibble(21,theta2)*4,getwibble(31,theta2)*4);
		thet2=theta2-11;
		posn=FVector(getwibble(11,thet2)*2,getwibble(21,thet2)*2,getwibble(31,thet2)*2);
		mycam.axes.Row[2]=posn-mycam.posn;
		mycam.axes.Normalise();



		p=brnp;
		for (c1=0;c1<numbp;c1++,p++)
		{
			rp=cam->axes*(p->p-cam->posn);
			if (rp.Z<MINZ) p->c=0; else
			{
				f=0.7*(lc+100)/rp.Z;
				p->c=64+60*(light*p->n);
				p->pz=int(rp.Z*5);
				p->px=160+f*rp.X;
				p->py=100+f*rp.Y;
			}
		}
		*/

		BRNL *l=brnl;

		linecol=lc/4;
		if ((curpos&31)<16) linecol=0;

		f=1+lc/200.f;

		if (lc) for (c1=0;c1<numbl;c1++,l++) if (l->a->c>0 && l->b->c>0)
		{
			line((l->a->px-160)*f+160,(l->a->py-100)*f+100,(l->b->px-160)*f+160,(l->b->py-100)*f+100);
		}

		ghosto(screenbuf+64000,screenbuf);

		/*
		{
			float th=theta*0.3;
			RadialBlur((unsigned char*)screenbuf+64000, 160+50*getwibble(134,th),100+50*getwibble(72,th), 0.7-fabs(0.3*getwibble(1,th)), -0.030);

			unsigned char *s=(unsigned char*)screenbuf+64000;
			for (c1=0;c1<64000;c1++,s++) *s=cliptab128[*s];
		}
		*/

		/*
		unsigned char *s=(unsigned char*)tex[0];
		unsigned char *d=(unsigned char*)screenbuf+64000;
		for (c1=0;c1<64000;c1++,d++,s++) if (d[0]<10) d[0]=*s;
		*/
		memcpy(screenbuf,screenbuf+64000,64000);
		composelight(screenbuf,tex[0],fadeptr);

		swapscreens(screenbuf);

		if (kbhit()) quit=1;
		if (curpos>=end) quit=1;

	}
	delete [] brnb;
	delete [] brnp;
	delete [] brnt;
	delete [] brnl;
	palrev=0;
	if (secondtime) setpalwhite();
	palpos=1;
	palspd=0.00001;
	palupdate=1;
	memset(screenbuf,0,64000);swapscreens();swapscreens();
}

void ronipart2()
{
	LFILE *f=openf((unsigned char*)"data\\dunetex.raw");
	readf(f,mypal,768);
	readf(f,tex[0],65536);
	closef(f);

	int c1,c2;
	for (c1=0;c1<256;c1++)
	{
		c2=c1;if (c2>63) c2=63;mypal[c1][0]=c2;
		c2=c1/2;if (c2>63) c2=63;mypal[c1][1]=c2;
		c2=c1/4;if (c2>63) c2=63;mypal[c1][2]=c2;
	}
	for (c1=0;c1<65536;c1++) tex[0][c1]*=0.6;

	setpalwhite(60);

	int cp=curpos;
	float t=0;
	while (!kbhit() && curpos<WARPEND)
	{
		int dt=dofproc();
		t+=0.03*dt;
		calcwibblepins(t,(PIN*)pin);
		softenpins(0.5);
		drawpinmapns(tex[0],screenbuf);

		if (cp!=curpos/16)
		{
			cp=curpos/16;
			setpalrev(30);
			palrev=1-palrev;
		}

		RadialBlur((unsigned char*)screenbuf, 160+50*getwibble(134,t*3),100+50*getwibble(72,t*3), 0.85, -0.025);

		//ghosto(screenbuf+64000,screenbuf);
		swapscreens(screenbuf);
	}
	palrev=0;
	memset(screenbuf,0,64000);swapscreens();swapscreens();
}

void makescalepins(float s, int cc)
{
	cc=(cc+16)*256;
	PIN *p = &pin[0][0];
	SLONG c1,c2;
	float scale=8*256/s;

	for (c1=0;c1<26;c1++)
	{
		for (c2=0;c2<41;c2++,p++)
		{

			p->u = 128*256+(c1-12.5)*scale;
			p->v = 128*256+(c2-20)*scale;
			p->col = cc;
		}
	}
}


void ronipart()
{
	int c1,c2;

	CAM mycam;
	mycam.posn=FVector(0,0,-5);
	mycam.axes.MakeID();
	FVector c[3];
	float t=4;
	dofproc();
	int n=0;

	unsigned char *b1=(unsigned char*)tex[1];
	unsigned char *b2=(unsigned char*)tex[2];
	unsigned char *b3;
	memset(b1,0,64000);
	memset(b2,0,64000);

	loadraw((unsigned char*)"data\\stoned.raw",tex[0]);
	//setpalblack();
	//palpos=1;paldest=0;
	//palspd=1/100;
	//setpal(mypal);
	setpalblack();
	palpos=1;
	paldest=0;
	palspd=1/120.f;

	//computefade("data\\silent.fad");
	readfade((unsigned char*)"data\\silent.fad");

	int rollpos=ROLLPOS-1;
	float scale=0.8;

	loadraw((unsigned char*)"data\\krol1.raw",tex[3],256,256,0,0,1);
	loadraw((unsigned char*)"data\\krol2.raw",tex[4],256,256,0,0,1);
	loadraw((unsigned char*)"data\\krol3.raw",tex[5],256,256,0,0,1);


	while (!kbhit() && curpos<ROLLEND)
	{
		memset(screenbuf,0,64000);

		for (c1=0;c1<3;c1++) c[c1]=FVector(getwibble(11+c1*10,t*0.4),getwibble(110+c1*10,t*0.3),0.1*getwibble(55+c1*10,t*0.5));

		float theta=t*0.4;
		mycam.posn=FVector(getwibble(11,theta),getwibble(21,theta),getwibble(31,theta));
		mycam.posn.Normalise();	mycam.posn=mycam.posn*19.5;
		float thet2=theta-11;
		FVector posn=FVector(getwibble(11,thet2)*2,getwibble(21,thet2)*2,getwibble(31,thet2)*2);
		mycam.axes.Row[2]=posn-mycam.posn;
		mycam.axes.Normalise();

		int dt=dofproc();
		t+=dt*0.051;
		int m=n+=dt*4;
		for (int y=0;y<25 && m>0;y++)
		for (int x=0;x<25 && m>0;x++)
		{
			m--;

			FVector p=FVector(9*getwibble(23,2*x*c[0].X+3*y*c[0].Y+t*c[0].Z),
							  9*getwibble(71,2*x*c[1].X+3*y*c[1].Y+t*c[1].Z),
							  9*getwibble(41,2*x*c[2].X+3*y*c[2].Y+t*c[2].Z));


			//if (p.Z>11) p.Z=11;if (p.Z<-11) p.Z=-11;
			//float r=fabs(p.Z)+4;float r1=r*sin(p.Y);
			//p=FVector(r1*cos(p.X),r1*sin(p.X),r*cos(p.Y));
			//p=FVector(0,0,0);

			p=mycam.axes*(p-mycam.posn);
			if (p.Z>1)
			{
				float f=150/p.Z;
				int ix=160+2*f*p.X;
				int iy=100+1.2*f*p.Y;
				//putpixel(ix,iy,255);
				if (ix>=0 && iy>=0 && ix<316 && iy<196)
				{
					int *d=(int*)(screenbuf+iy*320+ix);
					d[  0]+=0x01020201*5;
					d[ 80]+=0x02040402*5;
					d[160]+=0x02040402*5;
					d[240]+=0x01020201*5;

				}
			}

		}

		ghosto(screenbuf+64000,screenbuf);

		unsigned char *s=b1+320;
		unsigned char *d=b2+320;
		unsigned char *s2=(unsigned char*)screenbuf+64000+320;
		for (c1=320;c1<64000-320;c1++)
		{
			*d++=cliptab[(s[-1]+s[1]+s[-320]+s[320]+s[0]+s[-2]+s[2])/8+*s2++];
			s++;
		}
		b3=b1;b1=b2;b2=b3;

		memcpy(screenbuf,tex[0],64000);
		composesil(screenbuf,b2,fadeptr);

		while (curpos>rollpos)
		{

			//palrev=!palrev;
			palupdate=1;
			rollpos++;
			scale*=1.0051;
			makescalepins(scale*1.3,(curpos-ROLLPOS));
			//makescalepins(scale*1.3,0);
			clippins();
		}
		if (curpos>=ROLLPOS)
		{
			int i=curpos%3;
			drawpinmapns(tex[(3+i)/4],b2);
			composelight(screenbuf,b2,fadeptr);
		}


		swapscreens(screenbuf);
	}
	palrev=0;
	memset(screenbuf,0,64000);
	swapscreens();
}

#define NUMSEG 32
#define ZZ 16
#define SKIP 8 // divides zz...


void tunnelpart()
{
	setpalwhite(1000000);
	palupdate=0;paldest=palpos=palspd=0;
	setpalwhite(1000000);
	palupdate=0;paldest=palpos=palspd=0;

	P3D *p;
	float tr[NUMSEG];
	float ta[NUMSEG];
	int c1,c2;

	loadraw((unsigned char*)"data\\fond.raw",tex[0]);
	memcpy(tex[1],mypal[0],128*3);
	memcpy(mypal[0],mypal[128],128*3);
	memcpy(mypal[128],tex[1],128*3);
	loadraw((unsigned char*)"data\\s.raw",tex[1],320,200,0,0);
	loadraw((unsigned char*)"data\\rep.raw",tex[2],320,200,0,0);
	loadraw((unsigned char*)"data\\repsh.raw",tex[3],320,200,0,0);
	for (c2=0;c2<4;c2++) for (c1=0;c1<64000;c1++) tex[c2][c1]|=128;
	mypal[0][0]=mypal[0][1]=mypal[0][2]=0;



	unsigned char *ssrle=new unsigned char[64000];makerle(ssrle,tex[1]);
	unsigned char *reprle=new unsigned char[64000];makerle(reprle,tex[2]);
	unsigned char *repshrle=new unsigned char[64000];makerle(repshrle,tex[3]);


	CAM mycam,*cam=&mycam;
	mycam.posn=FVector(0,0,-5);
	mycam.axes.MakeID();

	p=new P3D[NUMSEG*ZZ*4];

	setpalwhite(1000000);
	palupdate=0;paldest=palpos=palspd=0;

	memcpy(destpal,mypal,768);

	//computeghost("data\\tunnel.gst",32,32);
	readghost((unsigned char*)"data\\tunnel.gst");
	//computefade("data\\tunnel.fad");
	readfade((unsigned char*)"data\\tunnel.fad");

	loadraw((unsigned char*)"data\\krol1.raw",tex[3],256,256,0,0,1);
	loadraw((unsigned char*)"data\\krol2.raw",tex[4],256,256,0,0,1);
	loadraw((unsigned char*)"data\\krol3.raw",tex[5],256,256,0,0,1);


	int sx[]={0,0,0};
	int sy[]={0,0,0};

	float t=3;
	float zof=0;

	int mp=0;
	float moos=11;
	int flashpos=TUNNELEND2-1;
	float scale=1.1;



	while (!kbhit() && curpos<TUNNELEND)
	{
		int dt=dofproc();

		t+=dt*0.04;
		zof+=dt*0.151;
		int izof=int(zof);

		memset(screenbuf,0,64000);





		for (int c0=0;c0<2;c0++)
		{

			float theta=t*5;
			mycam.posn=FVector(getwibble(11,theta),getwibble(21,theta),getwibble(31,theta));

			if (c0)
			{
				mycam.posn.Normalise();
				mycam.posn=mycam.posn*moos;
				moos-=dt*0.04;
				if (moos<0.5) moos=0.5;
			}else
			{
				mycam.posn.Normalise();
				mycam.posn=mycam.posn*11.5;
			}
			float thet2=theta-11;
			FVector posn=FVector(getwibble(11,thet2)*2,getwibble(21,thet2)*2,getwibble(31,thet2)*2);
			mycam.axes.Row[2]=posn-mycam.posn;
			mycam.axes.Normalise();



			P3D *pp=p;
			float z=-NUMSEG+(zof-izof)*2;
			for (c2=0;c2<NUMSEG;c2++)
			{
				tr[c2]=3+2*getwibble(10,t+(c2-izof)*211);
				if ((izof+c2)&1) tr[c2]=-tr[c2]+3*2;
				ta[c2]=11*getwibble(75,t+(c2-izof)*135);

				float r=tr[c2];
				float th=ta[c2];
				for (c1=0;c1<=ZZ;c1++)
				{
					pp->p=FVector(r*sin(th+c1*PI*2/ZZ),r*cos(th+c1*PI*2/ZZ),z);
					pp++;
					pp->p=pp[-1].p+FVector(0,0,1);
					pp++;
				}
				z+=2;
			}
			pp=p;
			for (c1=0;c1<(ZZ+1)*NUMSEG*2;c1++)
			{
				pp->rp=cam->axes*(pp->p-cam->posn);
				if (pp->rp.Z>MINZ)
				{
					float f=SCALE/pp->rp.Z;
					pp->px=160+f*pp->rp.X;
					pp->py=100+f*pp->rp.Y;
				}
				pp++;
			}
			pp=p;
			#define SWAP(x,y) {int i=x;x=y;y=i;}
			FVector light(getwibble(1,t),getwibble(2,t),getwibble(3,t));
			light.Normalise();

			for (c1=0;c1<NUMSEG;c1++)
			{
				for (c2=0;c2<ZZ;c2++)
				{
					if ((c2%SKIP)!=0)
					{
						FVector a=pp[0].rp-pp[1].rp;
						FVector b=pp[2].rp-pp[1].rp;
						a=a^b;a.Normalise();

						int lc=35-pp[0].rp.Z*2;
						if (lc<2) lc=2;if (lc>32) lc=32;
						linecol=lc;

						int c=(a*light+1)*(lc*(c0+2))/2;if (c>127) c=127;
						if (c<0) c=0;
						if (pp[0].rp.Z>MINZ && pp[1].rp.Z>MINZ && pp[2].rp.Z>MINZ)
						{
							int vv[]={pp[0].px,pp[0].py,pp[1].px,pp[1].py,pp[2].px,pp[2].py};
							if (flattri(screenbuf,vv,c/2)<0)
							{
								SWAP(vv[0],vv[2]);SWAP(vv[1],vv[3]);
								flattri(screenbuf,vv,c);
							}
							line(vv[0],vv[1],vv[2],vv[3]);
							line(vv[4],vv[5],vv[2],vv[3]);
							line(vv[4],vv[5],vv[0],vv[1]);
						}
						if (pp[1].rp.Z>MINZ && pp[2].rp.Z>MINZ && pp[3].rp.Z>MINZ)
						{
							int vv[]={pp[1].px,pp[1].py,pp[3].px,pp[3].py,pp[2].px,pp[2].py};
							if (flattri(screenbuf,vv,c/2)<0)
							{
								SWAP(vv[0],vv[2]);SWAP(vv[1],vv[3]);
								flattri(screenbuf,vv,c);

							}
							line(vv[0],vv[1],vv[2],vv[3]);
							line(vv[4],vv[5],vv[2],vv[3]);
						}
					}
					pp+=2;
				}
				pp+=2;
			}

			t+=15;

		} // major tunnel loop
		t-=15*2;


		//for (c1=0;c1<768;c1++) destpal[0][c1]=c1/12;	//destpal[0][c1]=

		float f=sin(t*5+frand(0.8))*0.4+0.6;

		for (c1=0;c1<256;c1++)
		for (c2=0;c2<3;c2++)
		{
			int c0=destpal[c1][c2]*f;
			if (c0<0) c0=0;
			if (c0>63) c0=63;
			mypal[c1][c2]=c0;
		}
		palupdate=1;



		/*
		unsigned char *s=(unsigned char*)tex[0];
		unsigned char *d=(unsigned char*)screenbuf;
		for (c1=0;c1<64000;c1++)
		{
			if (*d==0) d[0]=*s;
			d++;s++;
		}
		*/
		compose(screenbuf,tex[0],ghostptr);

		drawrle(screenbuf+sx[0]+sy[0]*320,ssrle,NULL);
		drawrle(screenbuf-sx[1]-sy[1]*320,repshrle,NULL);
		drawrle(screenbuf-sx[2]+sy[2]*320,reprle,NULL);

		for (c1=0;c1<200;c1++) memset(screenbuf+c1*320,0,5);


		if (curpos/2!=mp)
		{
			mp=curpos/2;
			for (c1=0;c1<3;c1++)
			{
				sx[c1]=(rand()%5);
				sy[c1]=rand()%7;
			}

		}

		int i;

		while (curpos>flashpos)
		{
			flashpos++;
			scale*=0.99;
			i=flashpos-TUNNELEND2;
			if (i==0 || i==2 || i==6 || i==8 || i==12 || i==14)
			{
				//palrev=!palrev;
				palupdate=1;
				scale*=0.95;
			}

			makescalepins(scale*1.3,0);
			clippins();

			i/=6;
			if (i<0) i=0;
			if (i>2) i=2;

		}

		if (curpos>TUNNELEND-16)
		{
			unsigned char *s=(unsigned char*)screenbuf;
			unsigned char *l=(unsigned char*)fadeptr+(48-(curpos-TUNNELEND+16)*2)*256;
			for (c1=0;c1<64000;c1++,s++) *s=l[*s];
		}

		if (curpos>TUNNELEND2)
		{
			drawpinmapns(tex[3+i],screenbuf+64000);
			composelight(screenbuf,screenbuf+64000,fadeptr);
		}
		swapscreens();
	}
	memset(screenbuf,0,64000);
	swapscreens();
	delete [] ssrle;
	delete [] reprle;
	delete [] repshrle;
	palrev=0;palupdate=1;
}

