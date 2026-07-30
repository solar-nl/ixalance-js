#include "stdafx.h"
#include "common.h"



#define MINZ 2.f
#define SCALE 230.f
#define SX 64
#define SY 64
#define SZ 32
#define DEPTH 0.55

struct BJP
{
	FVector p,rp;
	FVector n,rn;
	int c;
	int u,v;
	int px,py,pz;
} *bjp;

struct BJT
{
	BJP *a,*b,*c;
	int sm;
	FVector n;
	UBYTE *tex;
	BJT *next;
} *bjt;

struct BJO
{

	int nump, numt;
	BJP *p;
	BJT *t;
	FVector posn;
	FMatrix axes;
	~BJO() {delete [] t; delete [] p;};
	BJO() {};
	BJO(BJO *o) {
		memcpy(this,o,sizeof(BJO));
		t=new BJT[numt];
		memcpy(t,o->t,sizeof(BJT)*numt);
		p=new BJP[nump];
		memcpy(p,o->p,sizeof(BJP)*nump);
		int c2;
		for (int c1=0;c1<numt;c1++)
		{
			c2=o->t[c1].a-o->p;t[c1].a=p+c2;
			c2=o->t[c1].b-o->p;t[c1].b=p+c2;
			c2=o->t[c1].c-o->p;t[c1].c=p+c2;
		}
	}
	void settex(UBYTE *tt) {for (int c1=0;c1<numt;c1++) t[c1].tex=tt;};
};


BJT **bjb;


float ddd=0;

#define FSCALE 0.0421

BJO * loadbjo(char *fname)
{
	BJO *o=new BJO;
	int c1;
	LFILE *f=openf((unsigned char*)fname);
	readf(f,&o->nump,4);int numbp=o->nump;o->p=new BJP[numbp];
	readf(f,&o->numt,4);int numbt=o->numt;o->t=new BJT[numbt];

	for (c1=0;c1<numbp;c1++)
	{
		readf(f,&o->p[c1].p.X,4);o->p[c1].p.X*=FSCALE;
		readf(f,&o->p[c1].p.Z,4);o->p[c1].p.Z*=FSCALE;
		readf(f,&o->p[c1].p.Y,4);o->p[c1].p.Y*=-FSCALE;//op[c1].p.Y=-brnp[c1].p.Y;
		o->p[c1].n=FVector(0,0,0);
	}
	for (c1=0;c1<numbt;c1++)
	{
		readf(f,o->t+c1,16);
		o->t[c1].a=o->p+((int)o->t[c1].a);
		o->t[c1].b=o->p+((int)o->t[c1].b);
		o->t[c1].c=o->p+((int)o->t[c1].c);
		FVector a=o->t[c1].a->p-o->t[c1].b->p;
		FVector b=o->t[c1].c->p-o->t[c1].b->p;
		a=a^b;a.Normalise();
		o->t[c1].n=a;
		o->t[c1].a->n+=a;
		o->t[c1].b->n+=a;
		o->t[c1].c->n+=a;
	}
	closef(f);
	for (c1=0;c1<numbp;c1++)
	{
		o->p[c1].n.Normalise();
		o->p[c1].c=64+64*(FVector(0.2,0.7,-0.4)*o->p[c1].n);
	}
	return o;
}

void renderbjo(BJO *o, CAM *cam)
{
	int c1;
	BJP *p=o->p;
	int numbp=o->nump;
	int numbt=o->numt;
	FVector posn=cam->axes*(o->posn-cam->posn);
	FMatrix axes=cam->axes*o->axes;


	//memset(screenbuf,0,64000);
	for (c1=0;c1<numbp;c1++,p++)
	{
		p->rp=axes* p->p + posn;
		p->rn=axes* p->n;
		p->u=128+128*p->rn.X;
		p->v=128+128*p->rn.Y;



		if (p->rp.Z<MINZ) p->c=0; else
		{
			float f=SCALE/p->rp.Z;
			p->c=16+40*ddd*fabs(p->rn.Z);
			if (p->c<5) p->c=5;
			p->pz=int(p->rp.Z*5);
			p->px=160+f*p->rp.X;
			p->py=100+f*p->rp.Y;
			//putpixel(p->px,p->py,127);
		}
	}
	//swapscreens();


	BJT *t=o->t;
	for (c1=0;c1<numbt;c1++,t++)
	{
		if (t->a->c!=0 && t->b->c!=0 && t->c->c!=0)
		{
			int c2=t->a->pz+t->b->pz+t->c->pz-MINZ*3;
			if (c2>0)
			{
				if (c2>=MAXBUK) c2=MAXBUK-1;
				c2=MAXBUK-1-c2;
				t->next=bjb[c2];
				bjb[c2]=t;
			}
		}
	}

}

unsigned char linetab[256];





void bjorkfade(unsigned char *d, unsigned char *s1, unsigned char *s2)
{
	unsigned char c2,c3;
	int c1;
	for (c1=0;c1<64000;c1++)
	{

		c2=fadeptr[((*d)<<8)+*s1++];
		c3=fadeptr[((64-*d)<<8)+linetab[*s2++]];
		*d++=ghostptr[(c2<<8)+c3];
	}
}

void makebjorkpath()
{

	CAM mycam;
	mycam.posn=FVector(0,0,0);
	mycam.axes.MakeID();

	CAM *cam=&mycam;

	int c1;

	GetMouseV();

	curfp=fpl=0;
	fpname=(unsigned char*)"data\\bjork.fpl";




	unsigned char *cr[5];
	cr[0]=new unsigned char[320*200];loadraw((unsigned char*)"cr1.raw",cr[0],320,200,0,0,1);
	cr[1]=new unsigned char[320*200];loadraw((unsigned char*)"cr2.raw",cr[1],320,200,0,0,1);
	cr[2]=new unsigned char[320*200];loadraw((unsigned char*)"cr3.raw",cr[2],320,200,0,0,1);
	cr[3]=new unsigned char[320*200];loadraw((unsigned char*)"cr4.raw",cr[3],320,200,0,0,1);
	cr[4]=new unsigned char[320*200];loadraw((unsigned char*)"cr5.raw",cr[4],320,200,0,0,1);

	LFILE *f=openf((unsigned char*)"data\\palflow.raw");
	readf(f,mypal[0],768);
	readf(f,tex[1],65536);
	readf(f,tex[2],65536);
	readf(f,tex[3],65536);
	closef(f);

	// read objects
	BJO * ob[4];
	ob[0]=loadbjo("data\\3bulbe.dat");
	ob[1]=loadbjo("data\\3spike.dat");
	ob[2]=loadbjo("data\\1bulbe.dat");
	ob[3]=loadbjo("data\\1spike.dat");
	bjb=new BJT*[MAXBUK];
	memset(bjb,0,MAXBUK*4);


	// flare!
	int c2,c3;
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

	//setpal(mypal);
	palpos=1;
	paldest=0;
	palspd=1/100.f;
	setpalwhite();



	//computefade("data\\bjork.fad");
	readfade((unsigned char*)"data\\bjork.fad");
	//computeghost("data\\bjork.gst",32,32);
	readghost((unsigned char*)"data\\bjork.gst");

	for (c1=0;c1<256;c1++) linetab[c1]=fadeptr[(16+32+(c1/4))*256];

	CAM cam2;

	////////////////////
	// plants
	BJO *plant[64][2];
	int nump=6;
	for (c1=0;c1<nump;c1++)
	{

		plant[c1][0]=new BJO(ob[(c1==0)?0:2]);
		if (c1==0) plant[c1][0]->posn=FVector(0,30,0); else
		{
                        plant[c1][0]->posn=FVector((19+frand(5))*sin(c1*PI*2/(nump-1)),30,(19+frand(5))*cos(c1*PI*2/(nump-1)));
		}


		FVector(frand(55),0,frand(55));
		plant[c1][0]->axes.MakeYRot(frand(6));
		FMatrix h;
		h.MakeZRot(frand(0.2));plant[c1][0]->axes=plant[c1][0]->axes*h;
		h.MakeXRot(frand(0.2));plant[c1][0]->axes=plant[c1][0]->axes*h;
		if (c1>0) plant[c1][0]->axes=plant[c1][0]->axes*(0.7+fabs(frand(0.7)));
		plant[c1][0]->settex(tex[1]);

		plant[c1][1]=new BJO(ob[(c1==0)?1:3]);
		plant[c1][1]->posn=plant[c1][0]->posn;
		plant[c1][1]->axes=plant[c1][0]->axes;
		plant[c1][1]->settex(tex[2]);
	}

	//////////////////////////
	// plasma

	f=openf((unsigned char*)"data\\plasma.raw");
	readf(f,tex[0],65536);
	for (c1=0;c1<65536;c1++)
	{
		c2=(tex[0][c1]-100)/2;
		if (c2<-16) c2=-16;
		if (c2>16) c2=16;
		tex[0][c1]=c2+16+16;
	}

	closef(f);


	FMatrix g,h;
//#define MAKEFP
#ifdef MAKEFP
#else
	loadfp(fpname);
#endif



	/////////////////////////
	// main loop

	float verth=60;//30
	int quit=0;
	float t=0;
	ddd=0;
	while (!quit)
	{
		int dt=dofproc();
		t+=0.0052*dt;

		float ccc=sin(t*13)*0.3+0.7-ddd;
		float eee=sin(t*16+43)*1.2;


		if (curpos>ENDBJORK-32)
		{
			ddd-=0.0065*dt;
			if (ddd<0) ddd=0;
			ccc*=ddd;
			//eee*=ddd;
			eee=eee*(ddd)+(1-ddd);
		} else if (curpos>3*64 && ddd<1) ddd+=0.00261*dt;

#ifdef MAKEFP
		t=curfp-1;
#endif

		float tt=t*1.195;

#ifdef MAKEFP
		GetMouseV();
		GetMouse();
		h.MakeYRot(mxv/1000.0f);
		g.MakeXRot(myv/1000.0f);
		mycam.axes=(g*h)*mycam.axes;
		if (mb==1) 	mycam.posn=mycam.posn+mycam.axes.Row[2]*5;
		if (mb==2) 	mycam.posn=mycam.posn-mycam.axes.Row[2]*5;


#else

		if (tt>fpl) tt=fpl;
		interpolate(tt,cam);


#endif


		unsigned char str2[128];
		sprintf((char*)str2,"%0.3f %f",tt,verth);
		monow(40+640,str2);



		verth=30+(tt-10.5)*30;if (verth>60) verth=60;if (verth<30) verth=30;
		memset(bjb,0,4*MAXBUK);

		for (c1=0;c1<nump;c1++)
		{
			plant[c1][0]->posn.Y=verth;
			plant[c1][1]->posn.Y=verth;
			renderbjo(plant[c1][0],cam);
			renderbjo(plant[c1][1],cam);
		}

		//memset(screenbuf,0,64000);
		memset(screenbuf+64000,0,64000);
		if (ccc>0) memset(tex[4],0,64000);



		h.MakeYRot(getwibble(23,t*3)*7);
		g.MakeXRot(getwibble(72,t*3)*7);
		FMatrix lcam=g*h;
		pinblob(&mycam,&lcam,1.f/SQR(60),1.f/SQR(verth),1.f/SQR(60),t,SCALE/8,ddd);
		if (ddd>0) drawpinmap(tex[3], screenbuf); else memset(screenbuf,0,64000);

		//int *dd=(int*)(screenbuf+64000);int *ss=(int*)screenbuf;
		//for (c1=0;c1<64000/4;c1++) *dd++= (*ss++>>2)&0x3f3f3f3f;
		//memcpy(screenbuf+64000,screenbuf,64000);

		for (c1=0;c1<MAXBUK;c1++)
		{
			BJT *bf=bjb[c1];
			while (bf)
			{
				int vv[]={bf->c->px,bf->c->py,bf->b->px,bf->b->py,bf->a->px,bf->a->py};
				int ss[]={bf->c->c,bf->b->c,bf->a->c,
						bf->c->u,bf->b->u,bf->a->u,
						bf->c->v,bf->b->v,bf->a->v
						};
				if (flattri(screenbuf+64000,vv,0)>0)
				{
					texptr=bf->tex;

					c2=32-(bf->a->rp.Z-MINZ)*0.2;
					c2*=ddd*fabs(eee);
					if (c2>32) c2=32;
					if (c2>0 && texptr==tex[1])
					{
						screenbuf+=64000;
						linecol=c2;
						line(vv[0],vv[1],vv[2],vv[3]);
						line(vv[4],vv[5],vv[2],vv[3]);
						line(vv[4],vv[5],vv[0],vv[1]);
						screenbuf-=64000;
					}



					texgoufill(screenbuf,ss,vv);
					FVector p;
					if (ccc>0 && curpos<ENDBJORK-32)
					{
						p=bf->a->rp;
						if (p.Z>3)
						{
							float f=(SCALE)/p.Z;
							int lightx=160+p.X*f;
							int lighty=100+p.Y*f;
							int lightz=f;
							int c=f*4*ccc;if (c>256) c=256;
							scalespr(lightx-lightz,lighty-lightz,lightx+lightz,lighty+lightz,tex[4],64,64,flare,c);
						}
					}
				}
				bf=bf->next;
			}
			bjb[c1]=NULL;
		}


		screenbuf+=64000;

		cam2.axes=mycam.axes;
		cam2.posn=mycam.posn*(4/60.f); setspherehandoff(&cam2,verth/60.f);
		linecol=20*fabs(eee);
		drawsphere2(&cam2,verth/60.f);
		screenbuf-=64000;

		//calcwibblepins(t*2,(PIN*)pin);
		//PIN *pp=(PIN*)pin;for (c1=0;c1<41*26;c1++,pp++) {pp->u*=0.8;pp->v*=0.8;};
		//drawpinmapns(tex[0],tex[5]);

		//memcpy(tex[4],screenbuf,64000);

		//bjorkfade((unsigned char*)tex[5],(unsigned char*)screenbuf,(unsigned char*)tex[4]);

		//bjorkfade((unsigned char*)tex[5],(unsigned char*)screenbuf,(unsigned char*)screenbuf+64000);
		//composelight(tex[5],tex[4],fadeptr);
		if (eee<0) composedark(screenbuf,screenbuf+64000,fadeptr);
			else composelight(screenbuf,screenbuf+64000,fadeptr);
		if (ccc>0) composelight(screenbuf,tex[4],fadeptr);

		int ii=curpos&63;
		if (ii>8 && ii<32 && curpos>3*64 && curpos<8*64)
		{
			int jj=(curpos/64)-3;
			int sx=3*getwibble(11,ii*11)-1;
			int sy=3*getwibble(23,ii*11)+3;

			if (jj>=0 && jj<5) composedark(screenbuf+sx+sy*320,cr[jj],fadeptr);
			sx=3*getwibble(11,ii*11);
			sy=3*getwibble(23,ii*11);
			if (jj>=0 && jj<5) composelight(screenbuf+sx+sy*320,cr[jj],fadeptr);

		}



		swapscreens(screenbuf);

#ifdef MAKEFP
		unsigned char str[128];

		sprintf(str,"step %d of %d   ",curfp+1,fpl);
		monow(160*10,str);
		if (kbhit())
		{
			unsigned char ch=getch();
			switch (ch)
			{
			case 'c':
				sprintf(str,"%d / %d  ",checkpolys(),numbf);
				monow(0,str);
				break;
			case 27:
				quit=1;
				break;
			default:
				processkey(ch,&mycam);
				break;
			}
		}
#else
		if (kbhit()) quit=1;
		if (curpos>=ENDBJORK-1) quit=1;
#endif

	}

	for (c2=0;c2<2;c2++) for (c1=0;c1<nump;c1++) delete plant[c1][c2];

	delete [] flare;

	delete [] bjb;

	delete ob[0];
	delete ob[1];
	delete ob[2];
	delete ob[3];

	delete [] cr[0];
	delete [] cr[1];
	delete [] cr[2];
	delete [] cr[3];
	delete [] cr[4];


	setpalrev(10000);


}
