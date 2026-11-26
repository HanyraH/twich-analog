import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import secrets
from typing import Annotated, Literal
from urllib.error import URLError
from urllib.request import urlopen

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
import jwt
from jwt.exceptions import InvalidTokenError
from pwdlib import PasswordHash
from pydantic import BaseModel, ConfigDict, EmailStr, Field
from sqlalchemy import DateTime, ForeignKey, String, create_engine, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker
import uvicorn

try:
    from .obs_service import OBSError, OBSManager
except ImportError:
    from obs_service import OBSError, OBSManager

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")
load_dotenv()

SECRET_KEY = os.environ["JWT_SECRET_KEY"]
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 12
password_hash = PasswordHash.recommended()
oauth2_cheme = OAuth2PasswordBearer(tokenUrl="/login")

MEDIAMTX_API_URL = os.getenv("MEDIAMTX_API_URL", "http://127.0.0.1:9997").rstrip("/")
MEDIAMTX_HOST = os.getenv("MEDIAMTX_HOST", "127.0.0.1")
MEDIAMTX_RTMP_PORT = int(os.getenv("MEDIAMTX_RTMP_PORT", "1935"))
MEDIAMTX_HLS_PORT = int(os.getenv("MEDIAMTX_HLS_PORT", "8888"))
MEDIAMTX_WEBRTC_PORT = int(os.getenv("MEDIAMTX_WEBRTC_PORT", "8889"))

obs_manager = OBSManager()

# база данных подлкючение создание
DATABASE_URL = f"sqlite:///{(BASE_DIR / 'users.db').as_posix()}"

engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread":False}
)


SessionLocal = sessionmaker(
    bind=engine,
    autoflush=False
)


class Base(DeclarativeBase):
    pass

class UserORM(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    hashed_password: Mapped[str] = mapped_column(String(255))


class StreamORM(Base):
    __tablename__ = "streams"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), unique=True, index=True)
    stream_key: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    title: Mapped[str] = mapped_column(String(140), default="Прямой эфир")
    mode: Mapped[str] = mapped_column(String(32), default="screen")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
    )

def get_db():
    with SessionLocal() as db:
        yield db


DbSession = Annotated[Session,Depends(get_db)]


#Shecmy 
class UserCreate(BaseModel):
    email:EmailStr
    password:str = Field(
        min_length=8,
        max_length=128
    )

class UserResponse(BaseModel):
    id:int
    email:EmailStr
    model_config=ConfigDict(from_attributes=True)

class TokenResponse(BaseModel):
    access_token: str
    token_type: str


class MyStreamResponse(BaseModel):
    stream_key: str
    path: str
    title: str
    mode: str
    rtmp_server: str
    whip_url: str
    whep_url: str
    hls_url: str


class StreamUpdateRequest(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=140)
    mode: Literal["screen", "obs"] | None = None


class PublicStreamItem(BaseModel):
    path: str
    stream_key: str
    title: str
    owner_email: str | None = None
    mode: str = "obs"
    ready: bool
    ready_time: str | None = None
    tracks: list[str] = []
    readers_count: int = 0
    bytes_received: int = 0
    whep_url: str
    hls_url: str


class StreamsListResponse(BaseModel):
    mediamtx_online: bool
    streams: list[PublicStreamItem]


class OBSConnectRequest(BaseModel):
    host: str = Field(default="127.0.0.1", min_length=1, max_length=128)
    port: int = Field(default=4455, ge=1, le=65535)
    password: str = Field(default="", max_length=256)


class OBSSceneRequest(BaseModel):
    scene_name: str = Field(min_length=1, max_length=256)


# создание jwt


def create_acces_token(user_id: int, email: str = "") -> str:
    expire = datetime.now(timezone.utc) + timedelta(
        minutes=ACCESS_TOKEN_EXPIRE_MINUTES
    )
    payload: dict[str, object] = {
        "sub": str(user_id),
        "exp": expire,
    }
    if email:
        payload["email"] = email

    token = jwt.encode(
        payload,
        SECRET_KEY,
        algorithm=ALGORITHM,
    )
    return token

# проверка авторизации пользователя
# 

def get_cerrent_user(token:Annotated[str,Depends(oauth2_cheme)],db:DbSession)-> UserORM:

    error = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="недействительный токен или просрочен",
        headers={"WWW-Authenticate":"Bearer"}
    )
    try:
        payload = jwt.decode(
            token,
            SECRET_KEY,
            algorithms=[ALGORITHM],
            options={"require":["sub","exp"]}
        )
        user_id = int(payload["sub"])

    except (InvalidTokenError,ValueError,TypeError):
        raise error from None

    user = db.get(UserORM,user_id)

    if user is None:
        raise error
    return user 

Cuerrentuser = Annotated[UserORM,Depends(get_cerrent_user)]

@asynccontextmanager
async def lifespan(app:FastAPI):
    Base.metadata.create_all(bind=engine)
    yield




app = FastAPI(title="Authenfication API",version="1.0.0",lifespan=lifespan)


# ОТКРЫТЬ ВСЕ CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"]
)

@app.get("/")
def home():
    return "fsdsfd"

@app.post("/register",response_model=UserResponse,status_code=status.HTTP_201_CREATED)
def register(data:UserCreate, db:DbSession):
    email = str(data.email).strip().lower()

    existing_user = db.scalar(select(UserORM).where(UserORM.email==email))
    if existing_user is not None:
        raise HTTPException(
            status_code=409,
            detail="email сущ"
        )
    
    hashed_password=password_hash.hash(data.password)
    new_user = UserORM(
        email=email,
        hashed_password = hashed_password
    )
    db.add(new_user)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail="Email есть"
        )from None

    db.refresh(new_user)

    return new_user


@app.post("/login", response_model=TokenResponse)
def login(form: Annotated[OAuth2PasswordRequestForm, Depends()], db: DbSession):
    email = form.username.strip().lower()
    user = db.scalar(select(UserORM).where(UserORM.email==email))

    if user is None:
        password_hash.verify(form.password,password_hash.hash("dummy"))
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="неверный логин пароль",
            headers={"WWW-Authenticate":"Bearer"}
        )
    if not password_hash.verify(form.password,user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="неверный логин пароль",
            headers={"WWW-Authenticate":"Bearer"}
        )

    token = create_acces_token(user.id, user.email)
    return TokenResponse(
        access_token=token,
        token_type="bearer"
    )


@app.get(
    "/me",
    response_model=UserResponse
)
def get_profile(current_user: Cuerrentuser):
    return current_user


def _build_stream_urls(stream_key: str) -> dict[str, str]:
    path = f"live/{stream_key}"
    return {
        "path": path,
        "rtmp_server": f"rtmp://{MEDIAMTX_HOST}:{MEDIAMTX_RTMP_PORT}/live",
        "whip_url": f"http://{MEDIAMTX_HOST}:{MEDIAMTX_WEBRTC_PORT}/{path}/whip",
        "whep_url": f"http://{MEDIAMTX_HOST}:{MEDIAMTX_WEBRTC_PORT}/{path}/whep",
        "hls_url": f"http://{MEDIAMTX_HOST}:{MEDIAMTX_HLS_PORT}/{path}/index.m3u8",
    }


def _generate_stream_key(user_id: int) -> str:
    return f"u{user_id}_{secrets.token_hex(6)}"


def get_or_create_stream(db: Session, user: UserORM) -> StreamORM:
    stream = db.scalar(select(StreamORM).where(StreamORM.user_id == user.id))
    if stream is not None:
        return stream

    default_name = user.email.split("@", 1)[0]
    stream = StreamORM(
        user_id=user.id,
        stream_key=_generate_stream_key(user.id),
        title=f"Эфир {default_name}",
        mode="screen",
    )
    db.add(stream)
    db.commit()
    db.refresh(stream)
    return stream


def _stream_to_response(stream: StreamORM) -> MyStreamResponse:
    urls = _build_stream_urls(stream.stream_key)
    return MyStreamResponse(
        stream_key=stream.stream_key,
        path=urls["path"],
        title=stream.title,
        mode=stream.mode,
        rtmp_server=urls["rtmp_server"],
        whip_url=urls["whip_url"],
        whep_url=urls["whep_url"],
        hls_url=urls["hls_url"],
    )


def _fetch_mediamtx_paths_sync() -> tuple[bool, list[dict]]:
    url = f"{MEDIAMTX_API_URL}/v3/paths/list"
    try:
        with urlopen(url, timeout=1.5) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            items = data.get("items") or []
            return True, items
    except (URLError, TimeoutError, OSError, ValueError):
        return False, []


@app.get("/streams/me", response_model=MyStreamResponse)
def get_my_stream(current_user: Cuerrentuser, db: DbSession):
    stream = get_or_create_stream(db, current_user)
    return _stream_to_response(stream)


@app.patch("/streams/me", response_model=MyStreamResponse)
def update_my_stream(data: StreamUpdateRequest, current_user: Cuerrentuser, db: DbSession):
    stream = get_or_create_stream(db, current_user)
    if data.title is not None:
        stream.title = data.title.strip()
    if data.mode is not None:
        stream.mode = data.mode
    stream.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(stream)
    return _stream_to_response(stream)


@app.post("/streams/me/rotate-key", response_model=MyStreamResponse)
def rotate_my_stream_key(current_user: Cuerrentuser, db: DbSession):
    stream = get_or_create_stream(db, current_user)
    stream.stream_key = _generate_stream_key(current_user.id)
    stream.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(stream)
    return _stream_to_response(stream)


@app.get("/streams", response_model=StreamsListResponse)
async def list_streams(db: DbSession):
    mediamtx_online, items = await asyncio.to_thread(_fetch_mediamtx_paths_sync)

    rows = db.execute(
        select(StreamORM, UserORM).join(UserORM, StreamORM.user_id == UserORM.id)
    ).all()
    by_path: dict[str, tuple[StreamORM, UserORM]] = {
        f"live/{stream.stream_key}": (stream, user) for stream, user in rows
    }

    result: list[PublicStreamItem] = []
    seen_paths: set[str] = set()

    for item in items:
        path = str(item.get("name") or "")
        if not path:
            continue
        seen_paths.add(path)
        ready = bool(item.get("ready"))
        if not ready:
            continue

        stream_key = path.split("/", 1)[1] if "/" in path else path
        matched = by_path.get(path)
        title = matched[0].title if matched else f"Канал {path}"
        owner_email = matched[1].email if matched else None
        mode = matched[0].mode if matched else "obs"

        result.append(
            PublicStreamItem(
                path=path,
                stream_key=stream_key,
                title=title,
                owner_email=owner_email,
                mode=mode,
                ready=True,
                ready_time=item.get("readyTime"),
                tracks=[str(t) for t in (item.get("tracks") or [])],
                readers_count=len(item.get("readers") or []),
                bytes_received=int(item.get("bytesReceived") or 0),
                whep_url=f"http://{MEDIAMTX_HOST}:{MEDIAMTX_WEBRTC_PORT}/{path}/whep",
                hls_url=f"http://{MEDIAMTX_HOST}:{MEDIAMTX_HLS_PORT}/{path}/index.m3u8",
            )
        )

    # Всегда показываем дефолтный канал live/stream, если он ещё не в списке,
    # чтобы зритель мог быстро переключиться на него при тесте OBS.
    if "live/stream" not in seen_paths:
        result.append(
            PublicStreamItem(
                path="live/stream",
                stream_key="stream",
                title="Стандартный канал OBS",
                owner_email=None,
                mode="obs",
                ready=False,
                whep_url=f"http://{MEDIAMTX_HOST}:{MEDIAMTX_WEBRTC_PORT}/live/stream/whep",
                hls_url=f"http://{MEDIAMTX_HOST}:{MEDIAMTX_HLS_PORT}/live/stream/index.m3u8",
            )
        )

    return StreamsListResponse(mediamtx_online=mediamtx_online, streams=result)


@app.post("/obs/connect")
async def obs_connect(data: OBSConnectRequest, current_user: Cuerrentuser):
    obs_manager.set_config(current_user.id, data.host, data.port, data.password)
    return await obs_manager.get_status(current_user.id)


@app.get("/obs/status")
async def obs_status(current_user: Cuerrentuser):
    return await obs_manager.get_status(current_user.id)


@app.post("/obs/configure")
async def obs_configure(current_user: Cuerrentuser, db: DbSession):
    stream = get_or_create_stream(db, current_user)
    stream.mode = "obs"
    stream.updated_at = datetime.now(timezone.utc)
    db.commit()
    rtmp_server = f"rtmp://{MEDIAMTX_HOST}:{MEDIAMTX_RTMP_PORT}/live"
    try:
        return await obs_manager.configure_stream(current_user.id, rtmp_server, stream.stream_key)
    except OBSError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from None


@app.post("/obs/stream/start")
async def obs_stream_start(current_user: Cuerrentuser):
    try:
        return await obs_manager.set_streaming(current_user.id, True)
    except OBSError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from None


@app.post("/obs/stream/stop")
async def obs_stream_stop(current_user: Cuerrentuser):
    try:
        return await obs_manager.set_streaming(current_user.id, False)
    except OBSError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from None


@app.post("/obs/scene")
async def obs_switch_scene(data: OBSSceneRequest, current_user: Cuerrentuser):
    try:
        return await obs_manager.set_scene(current_user.id, data.scene_name)
    except OBSError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from None


@app.post("/obs/monitor-demo")
async def obs_monitor_demo(current_user: Cuerrentuser, db: DbSession):
    stream = get_or_create_stream(db, current_user)
    stream.mode = "obs"
    stream.updated_at = datetime.now(timezone.utc)
    db.commit()
    rtmp_server = f"rtmp://{MEDIAMTX_HOST}:{MEDIAMTX_RTMP_PORT}/live"
    try:
        return await obs_manager.start_monitor_demo(
            current_user.id, rtmp_server, stream.stream_key
        )
    except OBSError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from None


if __name__ == "__main__":
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)