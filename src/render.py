"""matplotlib renderer — Appendix A styling with the Appendix B deltas applied.

Layout: DAY | DATE | TIME | TEAM | H/A | STAR | STATUS | STANDING '26 '24 '25 NOW |
        GF/G | GA/G | GF/GA | TOT/G | LAST | MATCH-N HIST '23 '24 '25 '26 |
        SEASON RECORD '23 '24 '25 '26 NOW | FT / WIN% | WEATHER | IMPORTANCE
"""
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle

INK="#14171f";MUTED="#9aa2b1";RULE="#dfe3ea";BAND="#f6f7f9";BG="#fff";SUB="#7b8494";FTBG="#eef3ee"
GOOD="#1a7f4e";BAD="#c0392b";ACCENT="#2b5fd9";DRAW="#b7791f";PURP="#8e44ad"
AMBER="#b7791f";ORANGE="#d35400";LOWc="#2e7d5b";WET="#2b6cb0";HOT="#d35400"
IMPc={"high":BAD,"modhi":ORANGE,"mod":AMBER,"low":LOWc}
IMPl={"high":"HIGH","modhi":"MOD-HI","mod":"MOD","low":"LOW"}
WXc={"wet":WET,"mix":AMBER,"dry":LOWc,"hot":HOT,"tbc":MUTED}
RES={"W":GOOD,"D":DRAW,"L":BAD,"-":MUTED}
STAT={"fit":("fit",GOOD),"exp.":("exp.",AMBER),"eased":("eased",AMBER),"out":("OUT",BAD),"—":("—",MUTED)}
f=lambda v:"—" if v is None else f"{v:.2f}"


def histcell(ax,x,ry,v):
    if v=="new": ax.text(x,ry,"new",fontsize=5.6,color=PURP,fontstyle="italic",va="center",ha="center")
    elif v in ("W","D","L"): ax.text(x,ry,v,fontsize=9.0,color=RES[v],fontweight="bold",va="center",ha="center")
    else: ax.text(x,ry,"—",fontsize=9.0,color=MUTED,va="center",ha="center")


def reccell(ax,x,ry,v):
    if v=="new": ax.text(x,ry,"new",fontsize=5.8,color=PURP,fontstyle="italic",va="center",ha="center"); return
    if v in ("—",None): ax.text(x,ry,"—",fontsize=8,color=MUTED,va="center",ha="center"); return
    w,d,l=[int(q) for q in v.split("-")]
    c=GOOD if (w>0 and l==0) else BAD if (w==0 and l>0) else INK
    ax.text(x,ry,v,fontsize=6.9,color=c,fontweight="bold" if c!=INK else "normal",va="center",ha="center")


def rankcell(ax,x,ry,v,releg):
    if v=="PROM": ax.text(x,ry,"PROM",fontsize=7.7,color=PURP,fontweight="bold",va="center",ha="center"); return
    if v=="new": ax.text(x,ry,"new",fontsize=5.8,color=PURP,fontstyle="italic",va="center",ha="center"); return
    if v in ("—",None): ax.text(x,ry,"—",fontsize=8,color=MUTED,va="center",ha="center"); return
    top=v in ("1","2","3","4");bot=v in releg
    ax.text(x,ry,v,fontsize=9.4,color=GOOD if top else BAD if bot else INK,
            fontweight="bold" if (top or bot) else "normal",va="center",ha="center")


def render(fname,title,sub,fixtures,stand_labels,hist_labels,hist_title,rec_labels,last_label,foot1,foot2,releg):
    """
    fixtures: list of dicts with keys
      day, date, time, wx=(line1,line2,cat), imp=(grade,text), done(bool),
      teams=[ {ha,team,star,status,standing:[4],gfg,gag,ratio,total,last,last_o,
               hist:[4],records:[5],res} x2 ]
      res = ("ft","W 4-1","W") if completed else ("wp",62.0,None) or ("wp",None,None)
    """
    n=len(fixtures)*2;LEFT,RIGHT=0.4,0.4;ROW_H=0.37;HEAD_H=0.64;TITLE_BLOCK=1.4;FOOT_H=0.9
    O=lambda v:LEFT+v
    X_DAY=O(0);X_DATE=O(0.46);X_TIME=O(1.1);X_TEAM=O(1.74);X_HA=O(3.42);X_STAR=O(3.78);X_STAT=O(5.14)
    XS=[O(5.99),O(6.49),O(6.99),O(7.49)]
    X_GFG=O(8.14);X_GAG=O(8.79);X_RAT=O(9.54);X_TOT=O(10.36);X_LAST=O(11.19)
    XH=[O(12.09),O(12.48),O(12.87),O(13.26)]
    XR=[O(13.98),O(14.62),O(15.26),O(15.90),O(16.58)]
    X_WIN=O(17.5);X_WX=O(18.5);X_IMP=O(20.75)
    W=X_IMP+2.85+RIGHT;H=TITLE_BLOCK+HEAD_H+n*ROW_H+FOOT_H
    fig=plt.figure(figsize=(W,H),dpi=170);fig.patch.set_facecolor(BG)
    ax=fig.add_axes([0,0,1,1]);ax.set_xlim(0,W);ax.set_ylim(0,H);ax.axis("off")
    y=H-0.48
    ax.text(LEFT,y,title,fontsize=18,fontweight="bold",color=INK,va="top")
    ax.text(LEFT,y-0.33,sub,fontsize=9.0,color=SUB,va="top")
    hy=H-TITLE_BLOCK
    ax.plot([LEFT,W-RIGHT],[hy,hy],color=INK,lw=1.4,zorder=3)
    # grouped headers
    for xs,glab,labs in ((XS,"STANDING",stand_labels),(XH,hist_title,hist_labels),(XR,"SEASON RECORD  W-D-L",rec_labels)):
        ax.text((xs[0]+xs[-1])/2,hy-0.14,glab,fontsize=7.0,fontweight="bold",color=SUB,ha="center")
        for xx,lb in zip(xs,labs):
            ax.text(xx,hy-0.34,lb,fontsize=6.3,fontweight="bold",color=ACCENT if lb=="NOW" else SUB,ha="center")
    for lab,x,al in [("DAY",X_DAY,"left"),("DATE",X_DATE,"left"),("TIME",X_TIME,"left"),("TEAM",X_TEAM,"left"),
        ("H/A",X_HA,"center"),("STAR",X_STAR,"left"),("STATUS",X_STAT,"center"),("GF/G",X_GFG,"center"),
        ("GA/G",X_GAG,"center"),("GF/GA",X_RAT,"center"),("TOT/G",X_TOT,"center"),(last_label,X_LAST,"center"),
        ("FT / WIN%",X_WIN,"center"),("WEATHER",X_WX,"left"),("IMPORTANCE",X_IMP,"left")]:
        ax.text(x,hy-0.22,lab,fontsize=7.2,fontweight="bold",color=SUB,va="center",ha=al)
    top=hy-HEAD_H
    ax.plot([LEFT,W-RIGHT],[top,top],color=RULE,lw=0.9,zorder=3)
    for mi,fx in enumerate(fixtures):
        pt=top-mi*2*ROW_H;pb=pt-2*ROW_H;mid=(pt+pb)/2
        if fx["done"]: ax.add_patch(Rectangle((LEFT,pb),W-LEFT-RIGHT,2*ROW_H,facecolor=FTBG,edgecolor="none",zorder=0))
        elif mi%2==1: ax.add_patch(Rectangle((LEFT,pb),W-LEFT-RIGHT,2*ROW_H,facecolor=BAND,edgecolor="none",zorder=0))
        d=fx["day"];dcol={"FRI":PURP,"THU":PURP,"SUN":ACCENT,"MON":ACCENT}.get(d,MUTED)
        ax.text(X_DAY,mid,d,fontsize=8.2,color=dcol,fontweight="bold" if d not in ("SAT","—") else "normal",va="center",ha="left")
        ax.text(X_DATE,mid,fx["date"],fontsize=8.4,color=INK,va="center",ha="left")
        ax.text(X_TIME,mid,fx["time"],fontsize=8.6,color=INK if fx["time"]!="—" else MUTED,va="center",ha="left")
        w1,w2,wk=fx["wx"]
        ax.text(X_WX,mid+0.10,w1,fontsize=8.0,color=WXc[wk],fontweight="bold",va="center",ha="left")
        ax.text(X_WX,mid-0.12,w2,fontsize=7.3,color=INK,va="center",ha="left")
        g,t=fx["imp"]
        ax.text(X_IMP,mid+0.10,IMPl[g],fontsize=8.6,color=IMPc[g],fontweight="bold",va="center",ha="left")
        ax.text(X_IMP,mid-0.12,t,fontsize=7.6,color=INK,va="center",ha="left")
        if fx["done"]: ax.text(X_WIN+0.42,mid,"FT",fontsize=6.2,color=MUTED,fontweight="bold",va="center",ha="left",rotation=90)
        for ti,tm in enumerate(fx["teams"]):
            ry=pt-(ti+0.5)*ROW_H;rk=tm["standing"][0]
            ax.text(X_TEAM,ry,tm["team"],fontsize=9.6,color=INK,fontweight="bold" if rk in("1","2") else "normal",va="center",ha="left")
            ax.text(X_HA,ry,tm["ha"],fontsize=9.1,color=ACCENT if tm["ha"]=="H" else SUB,fontweight="bold" if tm["ha"]=="H" else "normal",va="center",ha="center")
            ax.text(X_STAR,ry,tm["star"],fontsize=8.9,color=INK if tm["star"]!="—" else MUTED,va="center",ha="left")
            st=STAT.get(tm["status"],("—",MUTED))
            ax.text(X_STAT,ry,st[0],fontsize=8.4,color=st[1],fontweight="bold" if tm["status"] in("fit","out") else "normal",va="center",ha="center")
            for xx,sv in zip(XS,tm["standing"]): rankcell(ax,xx,ry,sv,releg)
            ax.text(X_GFG,ry,f(tm["gfg"]),fontsize=9.2,color=INK if tm["gfg"] is not None else MUTED,va="center",ha="center")
            ax.text(X_GAG,ry,f(tm["gag"]),fontsize=9.2,color=INK if tm["gag"] is not None else MUTED,va="center",ha="center")
            r=tm["ratio"]
            rc,rw=(MUTED,"normal") if r is None else (GOOD,"bold") if r>=1.30 else (GOOD,"normal") if r>=1.00 else (INK,"normal") if r>=0.90 else (BAD,"bold")
            ax.text(X_RAT,ry,f(r),fontsize=9.4,color=rc,fontweight=rw,va="center",ha="center")
            tt=tm["total"]
            tc,tw=(MUTED,"normal") if tt is None else (BAD,"bold") if tt>=3.0 else (GOOD,"bold") if tt<=2.5 else (INK,"normal")
            ax.text(X_TOT,ry,f(tt),fontsize=9.2,color=tc,fontweight=tw,va="center",ha="center")
            ax.text(X_LAST,ry,tm["last"],fontsize=8.7,color=RES.get(tm["last_o"],MUTED),fontweight="bold" if tm["last_o"] in RES else "normal",va="center",ha="center")
            for xx,hv in zip(XH,tm["hist"]): histcell(ax,xx,ry,hv)
            for xx,rv in zip(XR,tm["records"]): reccell(ax,xx,ry,rv)
            kind,val,o=tm["res"]
            if kind=="ft": ax.text(X_WIN,ry,val,fontsize=9.0,color=RES[o],fontweight="bold",va="center",ha="center")
            elif val is None: ax.text(X_WIN,ry,"—",fontsize=9.0,color=MUTED,va="center",ha="center")
            else: ax.text(X_WIN,ry,f"{val:.0f}%",fontsize=9.2,color=GOOD if val>=50 else INK,fontweight="bold" if val>=55 else "normal",va="center",ha="center")
        ax.plot([LEFT,W-RIGHT],[pb,pb],color=RULE,lw=0.7,zorder=2)
    for xd in (XS[0]-0.3,XH[0]-0.25,XR[0]-0.34,X_WIN-0.42,X_WX-0.2,X_IMP-0.2):
        ax.plot([xd,xd],[top,top-n*ROW_H],color=RULE,lw=0.8,zorder=1)
    tb=top-n*ROW_H
    ax.plot([LEFT,W-RIGHT],[tb,tb],color=INK,lw=1.2,zorder=3)
    ax.text(LEFT,tb-0.27,foot1,fontsize=7.1,color=SUB,va="top")
    ax.text(LEFT,tb-0.47,foot2,fontsize=7.1,color=SUB,va="top")
    fig.savefig(fname,facecolor=BG,dpi=170,bbox_inches="tight",pad_inches=0.15)
    plt.close(fig)
