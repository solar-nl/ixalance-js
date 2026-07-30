#include "stdafx.h"
#include "common.h"


// break^otb
// breakin/outbreak

unsigned long next = 1;
int wrand()
{
next=next*1103515245 + 12345;
return (unsigned int)(next/65536) %32768;
}

void wsrand(unsigned int seed)
{
next=seed;
}

#define MINZ 2.f
#define SCALE 200.f
#define SX 64
#define SY 64
#define SZ 32

#define DEPTH 0.55

int clip(int i)
{
	if (i<1) i=1;
	return i;
}

int light(float dot, float z)
{
	int i=(dot+0.2)*60;
	i-=DEPTH*z;
	if (i>127) i=127;
	if (i<1) i=1;
	return i;
}

typedef unsigned char MAP[SZ][SY][SX];

MAP *map,*map2,*map3;

void sphere(int x1,int y1,int z1,int x2,int y2,int z2)
{
	int x,y,z;
	int x3=(x1+x2)/2;
	int y3=(y1+y2)/2;
	int z3=(z1+z2)/2;
	int r=(SQR(x2-x1)+SQR(y2-y1)+SQR(z2-z1))/12;
	for (z=z1;z<z2;z++)
	for (y=y1;y<y2;y++)
	for (x=x1;x<x2;x++)
	{
		if (x>=1 && x<SX-1 && y>=1 && y<SY-1 && z>=1 && z<SZ-1)
			if (SQR(x-x3)+SQR(y-y3)+SQR(z-z3)<r) (*map)[z][y][x]=wrand()&127;
	}
}

void calcmap()
{
	int x,y,z,zs,ys,c1;
	map=(MAP*)malloc(sizeof(MAP));
	map2=(MAP*)malloc(sizeof(MAP));

	printf("life takes time");flushall();

	wsrand(23*72);

	memset(map,255,sizeof(MAP));
	for (z=1;z<SZ/2;z++)
	{
		zs=3*SQR(z-(SZ/2));
		for (y=1;y<SY/2;y++)
		{
			ys=SQR(y-(SY/2))+zs;
			for (x=1;x<SX/2;x++)
			{
				(*map)[z][y][x]=(*map)[SZ-1-z][y][x]=
				(*map)[z][SY-1-y][x]=(*map)[SZ-1-z][SY-1-y][x]=
				(*map)[z][y][SX-1-x]=(*map)[SZ-1-z][y][SX-1-x]=
				(*map)[z][SY-1-y][SX-1-x]=(*map)[SZ-1-z][SY-1-y][SX-1-x]=
				128-80*(cos((48.f/SX)*sqrt(SQR(x-(SX/2))+ys)));

			}
		}
	}
	printf(".");flushall();
	for (c1=0;c1<20;c1++)
	{
		x=wrand()&(SX-1);
		y=wrand()&(SY-1);
		z=wrand()&(SZ-1);
		int r=(wrand()&7)+7;
		sphere(x-r,y-r,z-r,x+r,y+r,z+r);
	}

	for (z=1;z<SZ-1;z++)
	for (y=1;y<SY-1;y++)
	for (x=1;x<SX-1;x++) (*map)[z][y][x]+=(wrand()&63)-32;

	// smooth

	memcpy(map2,map,sizeof(MAP));
	for (c1=0;c1<6;c1++)
	{

		for (z=1;z<SZ-1;z++)
		{
			unsigned char *src=&((*map)[z][1][1]);
			unsigned char *dst=&((*map2)[z][1][1]);
			for (y=1;y<SY-1;y++,src+=2,dst+=2)
			for (x=1;x<SX-1;x++,src++,dst++)
			{
				*dst=(src[-1]+src[+1]+src[-SX]+src[+SX]+src[-SX*SY]+src[SX*SY]+src[0])/7;
			}
		}
		map3=map;map=map2;map2=map3;
		printf(".");flushall();
	}

	free(map2);
	printf("\n");

	/*
	fi=fopen("data\\map.3d","wb");
	if (fi)
	{
		fwrite(*map,sizeof(MAP),1,fi);
		fclose(fi);
		return;
	}
	*/
}

#define BLOBSIZE 4
float pval[8];
float tempcoord[3];


BLOBV *bv;
BLOBF *bf;
BLOBV *bvhash[MAXHASH];
BLOBF **buk=new BLOBF*[MAXBUK];//(BLOBF**)bvhash;
int numbv,numbf;

int hashp(const FVector &pp)
{
	return (int(pp.X)^int(pp.Y*pp.Z))&(MAXHASH-1);
}

int addpoint(const FVector &pp)
{
	int h=hashp(pp);
	BLOBV *v=bvhash[h];
	while (v)
	{
		if (v->p==pp) return v-bv;
		v=v->next;
	}
	v=&bv[numbv++];
	if (numbv>=MAXBV) exit(1);
	v->p=pp;
	v->next=bvhash[h];
	v->n=FVector(0,0,0);
	v->u=int((getwibble( 0,pp.X/3)+getwibble(10,pp.Y/3)+getwibble(20,pp.Z/3))*50)+128;
	v->v=int((getwibble(30,pp.X/3)+getwibble(40,pp.Y/3)+getwibble(50,pp.Z/3))*50)+128;
	bvhash[h]=v;
	return v-bv;
}

void addface(int a,int b, int c)
{
	if (a==b || a==c || b==c) return;
	BLOBF *f=&bf[numbf++];
	if (numbf>=MAXBF) exit(1);
	f->a=bv+a;
	f->b=bv+b;
	f->c=bv+c;
}

void calcblobpoint(SLONG i)
{
	switch (i)
	{
	case 0:

		if (pval[0]!=pval[4]) tempcoord[0]=(BLOBSIZE*pval[0])/(pval[0]-pval[4]);
		tempcoord[1]=0;
		tempcoord[2]=0;
		break;
	case 1:
		if (pval[1]!=pval[5]) tempcoord[0]=(BLOBSIZE*pval[1])/(pval[1]-pval[5]);
		tempcoord[1]=0;
		tempcoord[2]=BLOBSIZE;
		break;
	case 2:
		if (pval[2]!=pval[6]) tempcoord[0]=(BLOBSIZE*pval[2])/(pval[2]-pval[6]);
		tempcoord[1]=BLOBSIZE;
		tempcoord[2]=0;
		break;
	case 3:
		if (pval[7]!=pval[3]) tempcoord[0]=(BLOBSIZE*pval[3])/(pval[3]-pval[7]);
		tempcoord[1]=BLOBSIZE;
		tempcoord[2]=BLOBSIZE;
		break;
	case 4:
		tempcoord[0]=0;
		if (pval[0]!=pval[2]) tempcoord[1]=(BLOBSIZE*pval[0])/(pval[0]-pval[2]);
		tempcoord[2]=0;
		break;
	case 5:
		tempcoord[0]=0;
		if (pval[1]!=pval[3]) tempcoord[1]=(BLOBSIZE*pval[1])/(pval[1]-pval[3]);
		tempcoord[2]=BLOBSIZE;
		break;
	case 6:
		tempcoord[0]=BLOBSIZE;
		if (pval[6]!=pval[4]) tempcoord[1]=(BLOBSIZE*pval[4])/(pval[4]-pval[6]);
		tempcoord[2]=0;
		break;
	case 7:
		tempcoord[0]=BLOBSIZE;
		if (pval[5]!=pval[7]) tempcoord[1]=(BLOBSIZE*pval[5])/(pval[5]-pval[7]);
		tempcoord[2]=BLOBSIZE;
		break;
	case 8:
		tempcoord[0]=0;
		tempcoord[1]=0;
		if (pval[0]!=pval[1]) tempcoord[2]=(BLOBSIZE*pval[0])/(pval[0]-pval[1]);
		break;
	case 9:
		tempcoord[0]=0;
		tempcoord[1]=BLOBSIZE;
		if (pval[2]!=pval[3]) tempcoord[2]=(BLOBSIZE*pval[2])/(pval[2]-pval[3]);
		break;
	case 10:
		tempcoord[0]=BLOBSIZE;
		tempcoord[1]=0;
		if (pval[5]!=pval[4]) tempcoord[2]=(BLOBSIZE*pval[4])/(pval[4]-pval[5]);
		break;
	case 11:
		tempcoord[0]=BLOBSIZE;
		tempcoord[1]=BLOBSIZE;
		if (pval[6]!=pval[7]) tempcoord[2]=(BLOBSIZE*pval[6])/(pval[6]-pval[7]);
		break;
	}

}

#define potential(x,y,z) (-(((*map)[z][y][x])-120L))

void addcubetris(SLONG x,SLONG y,SLONG z)
{
	SLONG in;
	in  = ((pval[0]=potential(x  ,y  ,z  ))>0?  1:0);
	in |= ((pval[1]=potential(x  ,y  ,z+1))>0?  2:0);
	in |= ((pval[2]=potential(x  ,y+1,z  ))>0?  4:0);
	in |= ((pval[3]=potential(x  ,y+1,z+1))>0?  8:0);
	in |= ((pval[4]=potential(x+1,y  ,z  ))>0? 16:0);
	in |= ((pval[5]=potential(x+1,y  ,z+1))>0? 32:0);
	in |= ((pval[6]=potential(x+1,y+1,z  ))>0? 64:0);
	in |= ((pval[7]=potential(x+1,y+1,z+1))>0?128:0);

	SLONG i,j;
	int idx[12];
	for (i=0;i<cubeinfo[in].nedge;i++)
	{
		calcblobpoint(j=cubeinfo[in].edge[i]);
		if (tempcoord[0]<0) tempcoord[0]=0;
		if (tempcoord[0]>BLOBSIZE) tempcoord[0]=BLOBSIZE;
		if (tempcoord[1]<0) tempcoord[1]=0;
		if (tempcoord[1]>BLOBSIZE) tempcoord[1]=BLOBSIZE;
		if (tempcoord[2]<0) tempcoord[2]=0;
		if (tempcoord[2]>BLOBSIZE) tempcoord[2]=BLOBSIZE;

		idx[j]=addpoint(FVector(tempcoord[0]+(x-SX/2)*BLOBSIZE,tempcoord[1]+(y-SY/2)*BLOBSIZE,tempcoord[2]+(z-SZ/2)*BLOBSIZE));
	}
	for (i=0;i<cubeinfo[in].ntri;i++)
	{
		addface(idx[cubeinfo[in].tri[i][0]],idx[cubeinfo[in].tri[i][1]],idx[cubeinfo[in].tri[i][2]]);
	}
}

void tracemap()
{
	int x,y,z;
	numbf=numbv=0;
	memset(bvhash,0,sizeof(bvhash));
	bv=new BLOBV[MAXBV];
	bf=new BLOBF[MAXBF];

	printf("isoisoiso");

	for (z=0;z<SZ-1;z++)
	{

	/*
		for (y=1;y<SY-1;y++)
		for (x=1;x<SX-1;x++)
		{
			putpixel(x+z+160,y+z,(((*map)[z][y][x])));
			putpixel(x+z,y+z,(((*map)[z][y][x])<128)?0:127);
		}
		swapscreens(screenbuf);
	*/

		for (y=0;y<SY-1;y++)
		{
			for (x=0;x<SX-1;x++)
			{
				addcubetris(x,y,z);
			}
		}
		if ((z&7)==0) printf(".");flushall();
	}


	// normals
	BLOBF *f=bf;
	int c1;
	for (c1=0;c1<numbf;c1++,f++)
	{
		FVector a=f->a->p-f->b->p;a.Normalise();
		FVector b=f->c->p-f->b->p;b.Normalise();
		FVector n=a^b;n.Normalise();
		f->a->n+=n;
		f->b->n+=n;
		f->c->n+=n;
	}
	BLOBV *v=bv;
	for (c1=0;c1<numbv;c1++,v++) v->n.Normalise();

	printf("\n");
	free(map);

	//unsigned char str[128];sprintf(str,"%d %d",numbv,numbf);monow(0,str);
}

int checkpolys()
{
	int c1;
	int cc=0;
	BLOBF *f;
	memset(screenbuf,0,64000);
	for (c1=MAXBUK-1;c1>=0;c1--)
	{
		f=buk[c1];
		while (f)
		{
			int vv[6]={f->a->px,f->a->py,f->b->px,f->b->py,f->c->px,f->c->py};
			if (flattri(0,vv,0)>0)
			{
				if (checkfill(screenbuf,127)>0)
				{
					cc++;
					f->used|=1;
				}
			}
			f=f->next;
		}
	}
	return cc;
}

CAM fpath[256];
int fpl;
int curfp;
unsigned char *fpname=NULL;


void loadfp(unsigned char *fpname)
{
	if (fpname)
	{
		LFILE *f=openf(fpname);
		readf(f,&fpl,4);
		curfp=0;
		readf(f,fpath,sizeof(CAM)*fpl);
		closef(f);
		fpath[fpl]=fpath[fpl+1]=fpath[fpl+2]=fpath[fpl-1];
	}
}

void savefp(unsigned char *fpname)
{
	if (fpname)
	{
		FILE *f=fopen((const char*)fpname,"wb");
		if (!f) return;
		fwrite(&fpl,1,4,f);
		fwrite(fpath,sizeof(CAM),fpl,f);
		fclose(f);
	}
}

void lazyinterpolate(float t, CAM *mycam)
{
	float tt,ttt,a,b,c,d;
	int ti=floor(t);
	t=t-ti;
	tt=t*t;
	ttt=t*tt;
	float f0=(-ttt+3*tt-3*t+1)/6;
	float f1=(3*ttt-6*tt+4)/6;
	float f2=(-3*ttt+3*tt+3*t+1)/6;
	float f3=(ttt)/6;
	if (ti<0) ti=0;
	float *in=(float*)(&fpath[ti]);
	float *out=(float*)(mycam);
	for (int c1=0;c1<12;c1++)
	{
		*out++=in[0]*f0+in[12]*f1+in[24]*f2+in[36]*f3;
		in++;
	}
}

void interpolate(float t,CAM *mycam)
{
	float tt,ttt,a,b,c,d;
	int ti=floor(t);
	t=t-ti;
	tt=t*t;
	ttt=t*tt;
	if (ti<0) ti=0;
	float *in=(float*)(&fpath[ti]);
	float *out=(float*)(mycam);
	for (int c1=0;c1<12;c1++)
	{
		// and here are simons beautiful equations. thanks simey!
		// interpolation will never be the same again. just ask
		// sp228@cam.ac.uk for all your maths needs!

		a=(-in[0]+3*in[12]-3*in[24]+in[36])/6;
		b=(in[0]-2*in[12]+in[24])/2;
		c=(-2*in[0]-3*in[12]+6*in[24]-in[36])/6;
		d=in[12];

		*out++=a*ttt+b*tt+c*t+d;
		in++;
	}
	mycam->axes.Normalise();
}

float fff[]={-3.2606,1.4556,-4.2051,0.9591,0.1869,-0.2125,-0.1943,0.9808,-0.0143,0.2057,0.0550,0.9971};

void processkey(unsigned char c, CAM *mycam)
{

	int moooo;
	switch (c)
	{
	case 'A':
	case 'a':
		//for (moooo=0;moooo<3;moooo++) fff[moooo]/=4/60.f;
		memcpy(mycam,fff,4*12);
		mycam->posn*=60.f/4;
		break;
	case 'L':
		loadfp(fpname);
		beep();
		goto jump;
	case 'S':
		savefp(fpname);
		beep();
		beep();
		break;
	case 'E':
		fpl=curfp;
		beep();
		break;
	case '+':
		if (curfp<fpl) curfp++;
		goto jump;
	case '-':
		if (curfp>0) curfp--;
		goto jump;
	case ' ':
		memmove(&fpath[curfp+1],&fpath[curfp],(fpl-curfp)*sizeof(CAM));
		memcpy(&fpath[curfp],mycam,sizeof(CAM));
		curfp++;
		fpl++;
		break;
	}
	return;
jump:
	if (curfp<fpl)
	{
		memcpy(mycam,&fpath[curfp],sizeof(CAM));
	}
}

void makefpath()
{

	CAM mycam;
	mycam.posn=FVector(0,0,0);
	mycam.axes.MakeID();

	CAM *cam=&mycam;

	int c1;

	GetMouseV();

	curfp=fpl=0;
	fpname=(unsigned char*)"data\\canyon.fpl";

	int quit=0;
	while (!quit)
	{
		GetMouseV();
		GetMouse();
		FMatrix h;h.MakeYRot(mxv/1000.0f);
		FMatrix g;g.MakeXRot(myv/1000.0f);
		mycam.axes=(g*h)*mycam.axes;
		if (mb==1) 	mycam.posn=mycam.posn+mycam.axes.Row[2]*5;
		if (mb==2) 	mycam.posn=mycam.posn-mycam.axes.Row[2]*5;

		memset(screenbuf,0,64000);
		BLOBV *v=bv;
		for (c1=0;c1<numbv;c1++,v++)
		{
			v->rp=cam->axes*(v->p-cam->posn);
			if (v->rp.Z>MINZ)
			{
				float f=SCALE/(v->rp.Z);
				v->px=160+f*v->rp.X;
				v->py=100+f*v->rp.Y;
				//putpixel(v->px,v->py,128+100*v->n.X);
			}
		}
		BLOBF *f=bf;

		memset(buk,0,4*MAXBUK);

		for (c1=0;c1<numbf;c1++,f++)
		{
			if (f->a->rp.Z>MINZ && f->b->rp.Z>MINZ && f->c->rp.Z>MINZ)
			{
				int zz=(f->a->rp.Z+f->b->rp.Z+f->c->rp.Z)-(MINZ*3);
				if (zz>=MAXBUK) zz=MAXBUK-1;
				zz=MAXBUK-1-zz;
				f->next=buk[zz];
				buk[zz]=f;
			}
		}
		for (c1=0;c1<MAXBUK;c1++)
		{
			f=buk[c1];
			while (f)
			{
				int vv[6]={f->a->px,f->a->py,f->b->px,f->b->py,f->c->px,f->c->py};
				int ss[3]={clip(f->a->n.X*40+64-f->a->rp.Z*DEPTH),clip(f->b->n.X*40+64-f->b->rp.Z*DEPTH),clip(f->c->n.X*40+64-f->c->rp.Z*DEPTH)};
				if (flattri(0,vv,ss[0])>0)
				{

					gouraudfill(screenbuf,ss,vv);
				}
				f=f->next;
			}
		}
		swapscreens(screenbuf);

		unsigned char str[128];

		sprintf((char*)str,"step %d of %d   ",curfp+1,fpl);
		monow(160*10,str);
		if (kbhit())
		{
			unsigned char ch=getch();
			switch (ch)
			{
			case 'c':
				sprintf((char*)str,"%d / %d  ",checkpolys(),numbf);
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

	}


	getch();


}


void calcfpath()
{
	CAM mycam;
	CAM *cam=&mycam;

	unsigned char str[127];
	fpname=(unsigned char*)"data\\canyon.fpl";
	loadfp(fpname);
	int c1;
	float t=0;
	int ti=0;
	#define EXTRA 1

	BLOBF *f;
	for (f=bf,c1=0;c1<numbf;c1++,f++) f->used=0;

	FILE *fo=fopen("data\\canyon.fbp","wb");


	while (t<fpl && (!kbhit()))
	{
		memset(screenbuf,0,64000);
		interpolate(t,cam);

		BLOBV *v=bv;
		for (c1=0;c1<numbv;c1++,v++)
		{
			v->rp=cam->axes*(v->p-cam->posn);
			if (v->rp.Z>MINZ)
			{
				float f=SCALE/(v->rp.Z);
				v->px=160+f*v->rp.X;
				v->py=100+f*v->rp.Y;
				putpixel(v->px,v->py,128+100*v->n.X);
			}
		}
		swapscreens(screenbuf);
		f=bf;
		memset(buk,0,4*MAXBUK);
		for (c1=0;c1<numbf;c1++,f++)
		{
			if (f->a->rp.Z>MINZ && f->b->rp.Z>MINZ && f->c->rp.Z>MINZ)
			{
				int zz=(f->a->rp.Z+f->b->rp.Z+f->c->rp.Z)-(MINZ*3);
				if (zz>=MAXBUK) zz=MAXBUK-1;
				zz=MAXBUK-1-zz;
				f->next=buk[zz];
				buk[zz]=f;
			}
		}
		// run the check

		c1=checkpolys();
		sprintf((char*)str,"%d ",c1);
		monow(18*160+10*(ti),str);

		t=t+1.f/32.f;
		ti++;
		if (ti>=8+EXTRA)
		{
			ti=0;
			t-=EXTRA/32.f;
			// write out the changes
			f=bf;
			c1=numbf;
			int cc=0;
			while (c1>0)
			{
				cc=0;
				while ((c1)>0 && (f->used==0 || f->used==3) && cc<65500)
				{
					cc++;
					f++;
					c1--;
				}
				fwrite(&cc,1,2,fo);
				cc=0;
				while ((c1)>0 && (f->used==1 || f->used==2) && cc<65500)
				{
					cc++;
					f++;
					c1--;
				}
				fwrite(&cc,1,2,fo);
				//printf("%d\n",numbf-c1);
			}
			f=bf;
			cc=0;
			for (c1=0;c1<numbf;c1++,f++)
			{
				f->used=(f->used*2)&2;
				cc+=f->used/2;
			}
			sprintf((char*)str,"%d  %6.3f / %d  ",cc,t,fpl);
			monow(160*14,str);
		}  // diskwrite

	}
	fclose(fo);
}

void putpixel2(int x, int y)
{
	if (x>=0 && y>=0 && x<320 && y<200) screenbuf[y*320+x]=255;
}

int getpixel2(int x, int y)
{
	if (x<0 || y<0 || x>=320 || y>=200) return 0; else return screenbuf[y*320+x]==255;
}


void runfpath()
{
	CAM mycam;
	CAM *cam;
	cam=&mycam;

	unsigned char beat[512];

	
	palpos=1;
	palspd=0.000001;
	paldest=0;
	palupdate=1;
	dofproc();


	unsigned char str[127];
	fpname=(unsigned char*)"data\\canyon.fpl";
	loadfp(fpname);
	int c1,c2;
	float t=0;
	float tn=0;
	int ti=0;

	BLOBV *v,*vlist;
	BLOBF *f,*flist;

	for (f=bf,c1=0;c1<numbf;c1++,f++) f->used=0;
	for (v=bv,c1=0;c1<numbv;c1++,v++) v->used=0;


	texptr=tex[0];

	LFILE *fi;

	loadraw((unsigned char*)"data\\z1.raw",tex[2],320,200);
	loadraw((unsigned char*)"data\\z2.raw",tex[3],320,200);
	loadraw((unsigned char*)"data\\z3.raw",tex[4],320,200);
	for (c2=2;c2<5;c2++) for (c1=0;c1<64000;c1++) tex[c2][c1]|=128;
	unsigned char *z1rle=new unsigned char[64000];makerle(z1rle,tex[2]);
	unsigned char *z2rle=new unsigned char[64000];makerle(z2rle,tex[3]);
	unsigned char *z3rle=new unsigned char[2*64000];makerle(z3rle,tex[4]);


	loadraw((unsigned char*)"data\\s.raw",tex[2],320,200,0,0);
	loadraw((unsigned char*)"data\\rep.raw",tex[3],320,200,0,0);
	loadraw((unsigned char*)"data\\repsh.raw",tex[4],320,200,0,0);
	for (c2=2;c2<5;c2++) for (c1=0;c1<64000;c1++) tex[c2][c1]|=128;
	mypal[0][0]=mypal[0][1]=mypal[0][2]=0;
	//setpal(mypal);
	unsigned char *ssrle=new unsigned char[64000];makerle(ssrle,tex[2]);
	unsigned char *reprle=new unsigned char[64000];makerle(reprle,tex[3]);
	unsigned char *repshrle=new unsigned char[64000];makerle(repshrle,tex[4]);


	fi=openf((unsigned char*)"data\\ice.raw");
	readf(fi,mypal,768);
	readf(fi,texptr,65536);
	closef(fi);


	fi=openf((unsigned char*)"data\\stoned.raw");
	readf(fi,mypal,768);
	closef(fi);
	//setpal(mypal);

	//computefade("data\\canyon.fad");
	readfade((unsigned char*)"data\\canyon.fad");


	unsigned char tmppal[256][3];

	fi=openf((unsigned char*)"data\\z3.raw");
	readf(fi,((unsigned char*)mypal)+384,384);
	closef(fi);

	memcpy(tmppal,mypal,768);
	//memcpy(destpal,mypal,768);

	fi=openf((unsigned char*)"data\\beat.dat");
	readf(fi,beat,32);
	for (c1=0;c1<512;c1++)
	{
		readf(fi,&beat[c1],1);
		readf(fi,&c2,4);
	}





	fi=openf((unsigned char*)"data\\sunflare.raw");
	readf(fi,tex[1],65536);
	for (c1=0;c1<65536;c1++)
	{
		tex[1][c1]>>=1;
		if (SQR((c1&255)-128)+SQR((c1>>8)-128)>128*128) tex[1][c1]=0;
	}
	closef(fi);


	paldest=0;
	palspd=1/100.f;

	int mp=0;
	int sx[]={0,0,0};
	int sy[]={0,0,0};


	// molecules

	int molnum=-1;
	float moldist[4]={13,11,11};
	MOL *mol[4]={makestarmol(),
				makestarmol(),
			   readmol((unsigned char*)"data\\ecstasy.mol"),
			   readmol((unsigned char*)"data\\caffeine.mol")};

	CAM molcam;
	molcam.axes.MakeID();
	float starpos=0;
	unsigned char *molscr=new unsigned char[64000];
	unsigned char *moltab=(unsigned char*)tex[6];
	memset(moltab+256,0,256);
	memset(moltab+512,127,256);
	for (c1=0;c1<256;c1++) moltab[c1]=c1;
	for (c1=0;c1<256;c1++) moltab[c1+768]=findcol((63-mypal[c1][0])*32,(63-mypal[c1][1])*32,(63-mypal[c1][2])*32);


	///////////////////////

#define DOSVER
#ifdef DOSVER
	LFILE *fo=openf((unsigned char*)"canyon.fbp");
#else
	FILE *fo=fopen((char*)"data/canyon.fbp","rb");
#endif
	dofproc();

	memset(screenbuf,0,320*240);swapscreens2();

	int cp=curpos;
	float fpgl=1;
	int s1=0,s2=0;
	float msc=0;

	dofproc();
	int introfade=1;

	while (t<fpl-2 && (!kbhit()) && curpos<PCREND)
	{
		int dt=dofproc();

		starpos+=dt*0.1f;
		if (molnum==0 || molnum==1) makestarpos(mol[molnum],starpos);

		if (palpos==paldest) {introfade=0;palspd=1/60.f;setpalcol(60,30,13);};

		while (cp<curpos)
		{
			cp++;

			if (cp>=NEWBEAT && cp<NEWBEAT+512)
			{
				//palrev=0;
				if (beat[cp-NEWBEAT]==5) {s2=!s2;if (cp<SSTART) setpalrev(20);}
				if (beat[cp-NEWBEAT]==3) {fpgl-=1;s1=!s1;}
				if (beat[cp-NEWBEAT]>=4) fpgl+=3;
				if ((cp&15)==8) s1=!s1;
				if ((cp&15)==0) s2=!s2;
			}
			else if (cp>=FLASHSTART)
			{
				introfade=0;
				int j=(cp&63);
				if (j==0 || j==0x18 || j==0x30) fpgl+=4; else
				if (j==8 || j==0x20 || j==0x38) fpgl+=2; else
				if (j==4 || j==0x1c || j==0x34) fpgl+=1; else
				if (j==2 || j==0x1a || j==0x32) fpgl+=0.35; else
				if (j==6 || j==0x1e || j==0x36) fpgl+=0.35;
			}
		}
		fpgl=fpgl*pow(0.9,dt*0.8);
		if (cp>=BUILDSTART)
		{
			/*
			for (c2=0;c2<3;c2++) for (c1=0;c1<256;c1++)
			{
				mypal[c1][c2]++;
				if (mypal[c1][c2]>63) mypal[c1][c2]=63;
			}
			*/
			//fpgl+=1;
		}
		if (!introfade)
		{
			if (cp<=FLASHSTART) palpos=0; else palpos=fpgl*0.7-0.5;
			if (cp>=SSTART) palpos=0;
		}



		//memset(screenbuf,0,64000);
		interpolate(t,cam);
		//mycam=fpath[int(t)];

		// read the data for the next 8 frames
		if (t>=tn)
		{
			f=bf;
			tn+=8.f/32;
			c1=0;
			while (c1<numbf)
			{
#ifdef DOSVER
				c2=0;readf(fo,&c2,2);c1+=c2;f+=c2;
				c2=0;readf(fo,&c2,2);c1+=c2;
#else
				c2=0;fread(&c2,1,2,fo);c1+=c2;f+=c2;
				c2=0;fread(&c2,1,2,fo);c1+=c2;
#endif
				while (c2--)
				{
					//if (c1<numbf)
					{
						if (f->used)
						{
							// delete points
							f->a->used--;
							f->b->used--;
							f->c->used--;
						}
						else
						{
							f->a->used++;
							f->b->used++;
							f->c->used++;
						}
						f->used^=1;
					}
					//c1++;
					f++;
				}
			}
			// build the used face and vertex lists
			flist=NULL;
			vlist=NULL;
			for (f=bf,c1=0;c1<numbf;c1++,f++) if (f->used)
			{
				f->next2=flist;flist=f;
			}
			for (v=bv,c1=0;c1<numbv;c1++,v++) if (v->used)
			{
				v->next=vlist;vlist=v;
			}
		}


		for (v=vlist;v;v=v->next)
		{
			v->rp=cam->axes*(v->p-cam->posn);
			if (v->rp.Z>MINZ)
			{
				float f=SCALE/(v->rp.Z);
				v->px=160+f*v->rp.X;
				v->py=100+f*v->rp.Y;
				//putpixel(v->px,v->py,128+100*v->n.X);
			}
		}

		f=bf;
		memset(buk,0,4*MAXBUK);
		for (f=flist;f;f=f->next2)
		{
			if (f->a->rp.Z>MINZ && f->b->rp.Z>MINZ && f->c->rp.Z>MINZ
				&& f->a->used && f->b->used && f->c->used)
			{
				int zz=(f->a->rp.Z+f->b->rp.Z+f->c->rp.Z)-(MINZ*3);
				if (zz>=MAXBUK) zz=MAXBUK-1;
				zz=MAXBUK-1-zz;
				f->next=buk[zz];
				buk[zz]=f;
			}
		}

		FVector mylight=cam->posn+cam->axes.Row[2]*25+FVector(getwibble(23,t*10)*15,getwibble(62,t*10)*15,getwibble(72,t*10)*20);
		FVector l=cam->axes*(mylight-cam->posn);
		int lbuk=(l.Z-MINZ)*3;
		int lx,ly;
		float lz;
		if (lbuk>=MAXBUK) lbuk=MAXBUK-1;
		if (lbuk>=0)
		{
			lbuk=MAXBUK-1-lbuk;
			float f=lz=SCALE/l.Z;
			lx=160+f*l.X;
			ly=100+f*l.Y;
		}

		for (c1=0;c1<MAXBUK;c1++)
		{
			f=buk[c1];
			while (f)
			{
				l=mylight-f->a->p;
				l.Normalise();
				int vv[6]={f->a->px,f->a->py,f->b->px,f->b->py,f->c->px,f->c->py};
				//int ss[3]={clip(f->a->n.X*40+64-f->a->rp.Z*DEPTH)/2,clip(f->b->n.X*40+64-f->b->rp.Z*DEPTH)/2,clip(f->c->n.X*40+64-f->c->rp.Z*DEPTH)/2};
				int ss[]={light(l*(f->a->n),f->a->rp.Z)/2+16,
						light(l*f->b->n,f->b->rp.Z)/2+16,
						light(l*f->c->n,f->c->rp.Z)/2+16,
						f->a->u,f->b->u,
						f->c->u,f->a->v,
						f->b->v,f->c->v
						};



				if (flattri(0,vv,0)>0)
				//if (flattri(screenbuf,vv,16+32)>0)
				{
					texgoufill(screenbuf,ss,vv);
					linecol=(ss[0]+ss[1]+ss[2]-16*3)/6;if (linecol>28) linecol=28;
					if (linecol>1)
					{
						line(vv[0],vv[1],vv[2],vv[3]);line(vv[4],vv[5],vv[2],vv[3]);line(vv[4],vv[5],vv[0],vv[1]);
					}

				}
				f=f->next;
			}
			if (c1==lbuk)
			{
				// draw the light stub
				putpixel2(lx,ly);
				putpixel2(lx-3,ly);
				putpixel2(lx+3,ly);
				putpixel2(lx,ly-3);
				putpixel2(lx,ly+3);

			}
		}
		if (lbuk>=0)
		{
			int i=(getpixel2(lx,ly))+
				  (getpixel2(lx-3,ly))+
				  (getpixel2(lx+3,ly))+
				  (getpixel2(lx,ly-3))+
				  (getpixel2(lx,ly+3));

			if (i)
			{
				int lz2=(i+3)*lz*2;
				scalespr(lx-lz2,ly-lz2,lx+lz2,ly+lz2,screenbuf,256,256,tex[1],i*70);
			}
		}

		// speed of flight

		t=t+dt*0.00611+t/1000;
		sprintf((char*)str,"%f ",t);
		monow(18*160,str);
		writecam(cam);


		if (curpos>SSTART)
		{
			if (s1) drawrle(screenbuf+sx[0]+sy[0]*320,ssrle,NULL);
			if (s2) drawrle(screenbuf-sx[1]-sy[1]*320,repshrle,NULL);
			if (s2) drawrle(screenbuf-sx[2]+sy[2]*320,reprle,NULL);

			for (c1=0;c1<200;c1++) memset(screenbuf+c1*320,0,5);
			if (curpos!=mp)
			{
				mp=curpos;
				for (c1=0;c1<3;c1++)
				{
					sx[c1]=(wrand()%5);
					sy[c1]=wrand()%7;
				}
			}

		}


		/*
		float f=sin(t*5+frand(0.8))*0.4+0.6;
		for (c1=128;c1<256;c1++)
		for (c2=0;c2<3;c2++)
		{
			int c0=tmppal[c1][c2]*f;
			if (c0<0) c0=0;
			if (c0>63) c0=63;
			mypal[c1][c2]=destpal[c1][c2]=c0;
		}

		palupdate=1;
		*/

		//if (*((unsigned char*)0x417)&3) compose(screenbuf,tex[3],ghostptr);

		if (molnum<0 && curpos>=TIMEZ1) molnum=0;
		if (molnum==0 && curpos>=TIMEZ2) molnum=1;
		if (molnum==1 && curpos>=TIMEZ3) molnum=2;
		if (molnum==2 && curpos>=TIMEZ4) molnum=3;

		if (molnum>=0 && curpos<=TIMEZ7)
		{
			float theta=t*5;
			molcam.posn=FVector(getwibble(11,theta),getwibble(21,theta),getwibble(31,theta));
			molcam.posn.Normalise();
			molcam.posn=(molcam.posn*(getwibble(41,theta*2)+2))*4;
			molcam.axes.Row[2]=FVector(0,0,0)-molcam.posn;
			molcam.axes.Normalise();

			MOL *m=mol[molnum];
			m->axes.MakeZRot(t);
			rotatemol(m,&molcam,msc+0.3*getwibble(23,theta));
			UBYTE *b=screenbuf;
			screenbuf=(unsigned char*)molscr;
			memset(screenbuf,0,64000);

			if (msc<1) msc+=dt*0.0061;
			if (msc>1) msc=1;

			drawmol2(m,  1,  1, 0.50*msc,1.0*msc);
			drawmol2(m,  2,  2, 0.40*msc,0.9*msc);
			drawmol2(m,  3,  3, 0.30*msc,0.8*msc);
			screenbuf=b;
			compose(screenbuf,molscr,moltab);

			int ii=molnum;
			if (curpos>=TIMEZ5) ii++;
			if (curpos>=TIMEZ6) ii++;
			if (curpos>=TIMEZ7) ii++;

			if (ii==1 || ii==5) drawrle(screenbuf,z1rle,NULL);
			if (ii==2 || ii==4) drawrle(screenbuf,z2rle,NULL);
			if (ii==3) drawrle(screenbuf,z3rle,NULL);
		}

		swapscreens(screenbuf);
	
	}
#ifdef DOSVER
	closef(fo);
#else
	fclose(fo);
#endif
	delete [] z1rle;
	delete [] z2rle;
	delete [] z3rle;
	delete molscr;
	delete mol[0];
	delete mol[1];
	delete mol[2];

	setpalwhite(1);
	palpos=1;
	paldest=0;
	palspd=0.00001;
	palrev=0;
	palupdate=1;

}
