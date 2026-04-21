#include<stdio.h>
#include<math.h>
void DOUT();
double E1();
double L1(double Z);
double C1(double Z);
double R1(double J,double Z);
double F1();
void FUNC(double T,double X[],int N);
double FU(int I,double T,double X[]);
double OP[100];
double H,X[130],T;
double PA[999];
double DX[130];
double DSIGN(double a,double b);


void DOUT(){
  OP[0]=X[2];
}

double E1(){
  double E1;
E1=PA[1];
  return(E1);
}

double L1(double Z){
  double L1;
L1=Z/PA[2];
  return(L1);
}

double C1(double Z){
  double C1;
C1=PA[3]*Z;
  return(C1);
}

double R1(double J,double Z){
  double R1;
R1=PA[4]*Z;
  return(R1);
}

double F1(){
  double F1;
F1=PA[5];
  return(F1);
}

void FUNC(double T,double X[],int N){
  DX[0]=(-C1(X[1])+E1()-R1(0,(-F1()+L1(X[0]))));
  DX[1]=(-F1()+L1(X[0]));
  DX[2]=L1(X[0]);
}

double FU(int I,double T,double X[]){
  double FU;
  FU=0.0e-00;
  return(FU);
}

