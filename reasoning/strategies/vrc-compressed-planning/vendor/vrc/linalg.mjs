// VENDORED: copied verbatim from vrc03r.zip vendor/vrc/src/linalg.mjs
/** Small-matrix numeric proposals. Their output is never a proof. */
export const identity=n=>Array.from({length:n},(_,i)=>Array.from({length:n},(_,j)=>+(i===j)));
export const transpose=A=>A[0].map((_,j)=>A.map(r=>r[j]));
export const matmul=(A,B)=>A.map(row=>B[0].map((_,j)=>row.reduce((s,a,k)=>s+a*B[k][j],0)));
export function inverse(A){const n=A.length,B=A.map((r,i)=>[...r,...identity(n)[i]]);for(let k=0;k<n;k++){let p=k;for(let i=k+1;i<n;i++)if(Math.abs(B[i][k])>Math.abs(B[p][k]))p=i;if(Math.abs(B[p][k])<1e-14)throw new Error('Singular numeric matrix');[B[k],B[p]]=[B[p],B[k]];const a=B[k][k];for(let j=0;j<2*n;j++)B[k][j]/=a;for(let i=0;i<n;i++)if(i!==k){const a=B[i][k];for(let j=0;j<2*n;j++)B[i][j]-=a*B[k][j];}}return B.map(r=>r.slice(n));}
export function symmetricEigen(A){const n=A.length,B=A.map(r=>[...r]),V=identity(n);for(let it=0;it<200*n*n;it++){let p=0,q=0,m=0,diag=1;for(let i=0;i<n;i++){diag=Math.max(diag,Math.abs(B[i][i]));for(let j=i+1;j<n;j++)if(Math.abs(B[i][j])>m){m=Math.abs(B[i][j]);p=i;q=j;}}
 if(m<1e-13*diag)break;const theta=0.5*Math.atan2(2*B[p][q],B[q][q]-B[p][p]),c=Math.cos(theta),s=Math.sin(theta);
 const app=B[p][p],aqq=B[q][q],apq=B[p][q];for(let k=0;k<n;k++)if(k!==p&&k!==q){const u=B[k][p],v=B[k][q];B[k][p]=B[p][k]=c*u-s*v;B[k][q]=B[q][k]=s*u+c*v;}
 B[p][p]=c*c*app-2*s*c*apq+s*s*aqq;B[q][q]=s*s*app+2*s*c*apq+c*c*aqq;B[p][q]=B[q][p]=0;
 for(let k=0;k<n;k++){const u=V[k][p],v=V[k][q];V[k][p]=c*u-s*v;V[k][q]=s*u+c*v;}}
 const order=Array.from({length:n},(_,i)=>i).sort((i,j)=>Math.abs(B[j][j])-Math.abs(B[i][i]));return {values:order.map(i=>B[i][i]),vectors:V.map(r=>order.map(i=>r[i]))};}
function qrSquare(A){const n=A.length,R=A.map(r=>[...r]),Q=identity(n);for(let k=0;k<n-1;k++){const v=Array.from({length:n-k},(_,i)=>R[k+i][k]);let norm=Math.hypot(...v);if(norm<1e-30)continue;v[0]+=(v[0]>=0?1:-1)*norm;norm=Math.hypot(...v);for(let i=0;i<v.length;i++)v[i]/=norm;for(let j=k;j<n;j++){let dot=0;for(let i=0;i<v.length;i++)dot+=v[i]*R[k+i][j];for(let i=0;i<v.length;i++)R[k+i][j]-=2*v[i]*dot;}for(let i=0;i<n;i++){let dot=0;for(let j=0;j<v.length;j++)dot+=Q[i][k+j]*v[j];for(let j=0;j<v.length;j++)Q[i][k+j]-=2*dot*v[j];}}return {Q,R};}
/** Real eigenvalues for <=5 dimensional, diagonalizable, real-spectrum pencils. */
export function realEigen(A){let B=A.map(r=>[...r]);const n=A.length,vals=[];let m=n;
 for(let it=0;it<2500&&m>1;it++){
  let lower=0;for(let j=0;j<m-1;j++)lower+=Math.abs(B[m-1][j]);
  if(lower<1e-10*(1+Math.abs(B[m-1][m-1]))){vals.push(B[m-1][m-1]);B=B.slice(0,m-1).map(r=>r.slice(0,m-1));m--;continue;}
  const a=B[m-2][m-2],b=B[m-2][m-1],c=B[m-1][m-2],d=B[m-1][m-1],disc=(a-d)**2+4*b*c;
  let shift=d;if(disc>=0){const r=Math.sqrt(disc),r1=(a+d+r)/2,r2=(a+d-r)/2;shift=Math.abs(r1-d)<Math.abs(r2-d)?r1:r2;}
  if(it%40===39)shift+=0.01*(1+Math.abs(d));
  const C=B.map((r,i)=>r.map((v,j)=>v-(i===j?shift:0))),{Q,R}=qrSquare(C);B=matmul(R,Q).map((r,i)=>r.map((v,j)=>v+(i===j?shift:0)));
 }
 if(m!==1)throw new Error('Real eigensolver did not converge');vals.push(B[0][0]);
 const vectors=vals.map(lambda=>{const C=A.map((r,i)=>r.map((v,j)=>v-(i===j?lambda:0))),{vectors:V}=symmetricEigen(matmul(transpose(C),C));return V.map(r=>r.at(-1));});return {values:vals,vectors:transpose(vectors)};
}
/** Column-pivoted modified Gram-Schmidt with reorthogonalization. */
export class LeastSquares {
 constructor(columns,{tolerance=1e-11}={}){
  const m=columns[0].length,n=columns.length;if(!columns.every(c=>c.length===m))throw new TypeError('Matrix shape');this.n=n;this.m=m;
  this.scales=columns.map(c=>{let scale=0;for(const v of c)scale=Math.max(scale,Math.abs(v));if(!scale)return 1e-30;let s=0;for(const v of c)s+=(v/scale)**2;return scale*Math.sqrt(s);});
  const W=columns.map((c,j)=>Float64Array.from(c,x=>x/this.scales[j])),P=Array.from({length:n},(_,j)=>j),Q=[],R=Array.from({length:n},()=>new Float64Array(n));let rank=0;
  const dot=(a,b)=>{let s=0;for(let i=0;i<m;i++)s+=a[i]*b[i];return s;};
  for(let k=0;k<n;k++){let p=k,best=-1;for(let j=k;j<n;j++){const norm=dot(W[j],W[j]);if(norm>best){best=norm;p=j;}}if(best<tolerance*tolerance)break;
    [W[p],W[k]]=[W[k],W[p]];[P[p],P[k]]=[P[k],P[p]];for(let j=0;j<k;j++)[R[j][p],R[j][k]]=[R[j][k],R[j][p]];
    const norm=Math.sqrt(dot(W[k],W[k]));R[k][k]=norm;const q=Float64Array.from(W[k],v=>v/norm);Q.push(q);rank++;
    for(let j=k+1;j<n;j++){let a=dot(q,W[j]);for(let i=0;i<m;i++)W[j][i]-=a*q[i];const correction=dot(q,W[j]);for(let i=0;i<m;i++)W[j][i]-=correction*q[i];R[k][j]=a+correction;}
  }
  this.Q=Q;this.R=R;this.P=P;this.rank=rank;
 }
 solve(y){if(y.length!==this.m)throw new TypeError('Target shape');const c=new Float64Array(this.n),r=this.rank;for(let k=r-1;k>=0;k--){let v=0;const q=this.Q[k];for(let i=0;i<y.length;i++)v+=q[i]*y[i];for(let j=k+1;j<r;j++)v-=this.R[k][j]*c[j];c[k]=v/this.R[k][k];}const out=new Float64Array(this.n);for(let k=0;k<r;k++)out[this.P[k]]=c[k]/this.scales[this.P[k]];return out;}
}
export function rng(seed=1234567){let a=seed>>>0;return ()=>{a+=0x6D2B79F5;let t=a;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return ((t^t>>>14)>>>0)/4294967296;};}
