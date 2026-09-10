# -*- coding: utf-8 -*-
"""Firestore EM MEMÓRIA pra testar o bot sem emulador e sem produção.

Envolve o `mock-firestore` (pip install mock-firestore) com os detalhes que
o app.py usa e o mock não cobre: kwargs `timeout=`, `merge=True`, batch,
`DELETE_FIELD`, `Increment` e `SERVER_TIMESTAMP`.

Uso típico (veja ambiente_teste.py e harness.py --memoria):

    from firestore_memoria import importar_app_sem_firebase, FirestoreMemoria
    bot = importar_app_sem_firebase()      # importa app.py sem credencial/rede
    bot.db = FirestoreMemoria()            # troca o banco
    bot.send_message = ...                 # bloqueia WhatsApp

Fidelidade: suficiente pro fluxo do bot (where/order_by/limit, merge,
batch). Não valida índices compostos nem regras de segurança — pra isso
existe o emulador (harness.py sem --memoria).
"""
import os
import sys
from datetime import datetime, timezone
from unittest import mock

try:
    import mockfirestore
except ImportError:  # mensagem clara em vez de stack trace
    sys.exit("Falta o pacote mock-firestore:  pip install mock-firestore")


def _nome_tipo(v):
    return type(v).__name__


def _separar_sentinelas(dados):
    """Devolve (campos_normais, deletar[], incrementar{k: n})."""
    normais, deletar, incrementar = {}, [], {}
    for k, v in (dados or {}).items():
        t = _nome_tipo(v)
        if t == "Sentinel":                       # SERVER_TIMESTAMP / DELETE_FIELD
            if "DELETE" in repr(v).upper():
                deletar.append(k)
            else:
                normais[k] = datetime.now(timezone.utc)
        elif t == "DeleteField":
            deletar.append(k)
        elif t == "Increment":
            incrementar[k] = getattr(v, "value", 0)
        else:
            normais[k] = v
    return normais, deletar, incrementar


class _Doc:
    def __init__(self, ref):
        self._r = ref

    @property
    def id(self):
        return self._r.id

    @property
    def reference(self):
        return self

    def get(self, **_k):
        return self._r.get()

    def set(self, dados, merge=False, **_k):
        normais, deletar, incrementar = _separar_sentinelas(dados)
        self._r.set(normais, merge=merge)
        self._aplicar(deletar, incrementar)

    def update(self, dados, **_k):
        normais, deletar, incrementar = _separar_sentinelas(dados)
        if normais:
            self._r.update(normais)
        self._aplicar(deletar, incrementar)

    def _aplicar(self, deletar, incrementar):
        if not deletar and not incrementar:
            return
        snap = self._r.get()
        atual = snap.to_dict() if snap.exists else {}
        for k in deletar:
            atual.pop(k, None)
        for k, n in incrementar.items():
            atual[k] = (atual.get(k) or 0) + n
        self._r.set(atual)

    def create(self, dados, **_k):
        snap = self._r.get()
        if snap.exists:
            from google.api_core import exceptions as gcp_exceptions
            raise gcp_exceptions.AlreadyExists("já existe")
        self.set(dados)

    def delete(self, **_k):
        return self._r.delete()


class _Query:
    def __init__(self, q):
        self._q = q

    def where(self, *a, **k):
        return _Query(self._q.where(*a, **k))

    def order_by(self, *a, **k):
        return _Query(self._q.order_by(*a, **k))

    def limit(self, n):
        return _Query(self._q.limit(n))

    def get(self, **_k):
        return list(self._q.stream())

    def stream(self, **_k):
        return self._q.stream()


class _Col(_Query):
    def document(self, doc_id=None):
        return _Doc(self._q.document(doc_id) if doc_id else self._q.document())

    def add(self, dados, **_k):
        normais, _, _ = _separar_sentinelas(dados)
        return self._q.add(normais)


class _Batch:
    def __init__(self):
        self._ops = []

    def set(self, ref, dados, merge=False):
        self._ops.append(lambda: ref.set(dados, merge=merge))

    def update(self, ref, dados):
        self._ops.append(lambda: ref.update(dados))

    def delete(self, ref):
        self._ops.append(lambda: ref.delete())

    def commit(self):
        for op in self._ops:
            op()
        self._ops = []


class FirestoreMemoria:
    """Substituto de `firestore.client()` que vive só na memória do processo."""

    def __init__(self):
        self._m = mockfirestore.MockFirestore()

    def collection(self, nome):
        return _Col(self._m.collection(nome))

    def batch(self):
        return _Batch()

    def exportar(self, colecao):
        """Lista de dicts (com 'id') de uma coleção — pra inspecionar/salvar."""
        return [{"id": d.id, **d.to_dict()} for d in self._m.collection(colecao).stream()]


def importar_app_sem_firebase(raiz=None):
    """Importa app.py com o Firebase Admin substituído por dublês — nada de
    credencial, nada de rede pro Firestore. Quem chama troca `bot.db` por
    um FirestoreMemoria em seguida."""
    raiz = raiz or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if raiz not in sys.path:
        sys.path.insert(0, raiz)
    os.environ.setdefault("FIREBASE_CREDENCIAL_PATH", "/dev/null")
    os.environ.setdefault("FIRESTORE_EMULATOR_HOST", "memoria:0")   # trava do seed
    with mock.patch("firebase_admin.credentials.Certificate", lambda *_a, **_k: object()), \
         mock.patch("firebase_admin.initialize_app", lambda *_a, **_k: None), \
         mock.patch("firebase_admin.firestore.client", lambda *_a, **_k: mock.MagicMock()):
        import app as bot  # noqa: E402
    return bot
